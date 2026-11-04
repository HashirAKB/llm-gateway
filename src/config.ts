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
  /** Hard spend limit in USD; requests are refused with 429 once spend reaches it. */
  budgetUsd: z.number().positive().optional(),
  /** Admin keys can read every key's usage (GET /v1/usage, dashboard). */
  admin: z.boolean().default(false),
});

const PriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
});

export const ConfigSchema = z
  .object({
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
    /** USD per million tokens, per concrete model name. */
    prices: z.record(z.string(), PriceSchema),
    guardrails: z
      .object({
        piiRedaction: z.boolean().default(true),
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
  })
  // Fail at startup, not at request time, if a routable model has no price.
  .superRefine((config, ctx) => {
    for (const [alias, targets] of Object.entries(config.routes)) {
      for (const target of targets) {
        if (!config.prices[target.model]) {
          ctx.addIssue({
            code: "custom",
            path: ["prices"],
            message: `Route "${alias}" uses model "${target.model}" which has no price`,
          });
        }
      }
    }
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
