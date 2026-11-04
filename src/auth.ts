import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { VirtualKey } from "./config.js";

/**
 * SHA-256 of a virtual key, as hex. Config files can store this instead of
 * the key itself, so a leaked config does not leak usable credentials.
 *
 * A fast hash is fine here (unlike for passwords): virtual keys are long
 * random strings, so there is nothing to brute-force from a dictionary.
 */
export function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Looks up virtual keys by the hash of the presented secret. Keys configured
 * in plaintext are hashed at startup, so both forms take the same path.
 */
export class KeyStore {
  private readonly byHash: Map<string, VirtualKey>;

  constructor(keys: VirtualKey[]) {
    this.byHash = new Map(keys.map((k) => [k.keyHash ?? hashKey(k.key!), k]));
  }

  find(secret: string | undefined): VirtualKey | undefined {
    return secret ? this.byHash.get(hashKey(secret)) : undefined;
  }
}

/** Reads the client's key from `Authorization: Bearer <key>` or `x-api-key`. */
export function readApiKey(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  const xApiKey = request.headers["x-api-key"];
  return typeof xApiKey === "string" ? xApiKey : undefined;
}
