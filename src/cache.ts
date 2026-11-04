import { createHash } from "node:crypto";
import type { MessagesRequest, MessagesResponse } from "./api.js";

export interface CacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  /** Cache replies even when temperature > 0 (the reply is then one sample, replayed). */
  cacheNonZeroTemperature: boolean;
}

/** The Anthropic default when a client omits temperature. */
const DEFAULT_TEMPERATURE = 1;

/**
 * Only deterministic, non-streaming requests are cached by default.
 * At temperature > 0 the same prompt should give varied answers, so replaying
 * one stored answer would silently change behaviour.
 */
export function isCacheable(body: MessagesRequest, config: CacheConfig): boolean {
  if (!config.enabled || body.stream) return false;
  const temperature = body.temperature ?? DEFAULT_TEMPERATURE;
  return temperature === 0 || config.cacheNonZeroTemperature;
}

/**
 * A stable hash of everything that affects the reply. "Normalised" means two
 * requests that differ only in JSON key order or surrounding whitespace in
 * message text get the same key. The virtual key name is part of the hash so
 * one tenant never receives another tenant's cached reply.
 */
export function cacheKey(keyName: string, body: MessagesRequest): string {
  const normalised = {
    tenant: keyName,
    model: body.model,
    system: body.system?.trim() ?? "",
    messages: body.messages.map((m) => ({ role: m.role, content: m.content.trim() })),
    max_tokens: body.max_tokens,
    temperature: body.temperature ?? DEFAULT_TEMPERATURE,
  };
  // JSON.stringify of an object literal built in a fixed order is canonical here.
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

interface Entry {
  value: MessagesResponse;
  expiresAt: number;
}

/**
 * In-memory exact-match cache with a TTL and a size cap.
 * A Map iterates in insertion order, so deleting and re-inserting on read
 * makes the first key the least recently used one: a tiny LRU.
 */
export class ResponseCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly config: Pick<CacheConfig, "ttlMs" | "maxEntries">,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): MessagesResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: MessagesResponse): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.config.ttlMs });
    if (this.entries.size > this.config.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
