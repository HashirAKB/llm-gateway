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
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type VirtualKey = z.infer<typeof VirtualKeySchema>;

/** Parses and validates a config object; throws a readable error if it is invalid. */
export function parseConfig(raw: unknown): GatewayConfig {
  return ConfigSchema.parse(raw);
}

export function loadConfig(path: string): GatewayConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
