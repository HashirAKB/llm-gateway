import { readFileSync } from "node:fs";
import { z } from "zod";

const TargetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

const VirtualKeySchema = z.object({
  /** The secret the client sends. Demo keys only; see README "Limitations". */
  key: z.string().min(8),
  /** Human-readable name used in logs, metrics and the usage report. */
  name: z.string().min(1),
  /** Optional per-key limits; a missing field means "no limit". */
  rateLimit: z
    .object({
      requestsPerMinute: z.number().int().positive().optional(),
      tokensPerMinute: z.number().int().positive().optional(),
    })
    .optional(),
});

export const ConfigSchema = z.object({
  keys: z.array(VirtualKeySchema).min(1),
  /** Alias -> ordered list of targets. The first healthy target wins. */
  routes: z.record(z.string(), z.array(TargetSchema).min(1)),
  mock: z
    .object({
      latencyMs: z.number().nonnegative().default(0),
      chunkDelayMs: z.number().nonnegative().default(0),
      errorRate: z.number().min(0).max(1).default(0),
    })
    .prefault({}),
  resilience: z
    .object({
      /** Per-attempt deadline. For streams it bounds the time to the first byte. */
      timeoutMs: z.number().positive().default(30_000),
      retry: z
        .object({
          maxAttempts: z.number().int().min(1).default(3),
          baseDelayMs: z.number().nonnegative().default(100),
          maxDelayMs: z.number().nonnegative().default(2_000),
        })
        .prefault({}),
      circuitBreaker: z
        .object({
          failureThreshold: z.number().int().min(1).default(5),
          cooldownMs: z.number().positive().default(30_000),
        })
        .prefault({}),
    })
    .prefault({}),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      ttlMs: z.number().positive().default(5 * 60_000),
      maxEntries: z.number().int().positive().default(10_000),
      cacheNonZeroTemperature: z.boolean().default(false),
    })
    .prefault({}),
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type VirtualKey = z.infer<typeof VirtualKeySchema>;
export type ResilienceConfig = GatewayConfig["resilience"];

/** Parses and validates a config object; throws a readable error if it is invalid. */
export function parseConfig(raw: unknown): GatewayConfig {
  return ConfigSchema.parse(raw);
}

export function loadConfig(path: string): GatewayConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
