export interface Price {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export type PriceTable = Record<string, Price>;

export function costUsd(prices: PriceTable, model: string, inputTokens: number, outputTokens: number): number {
  const price = prices[model];
  if (!price) throw new Error(`No price configured for model "${model}"`);
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  cached: boolean;
}

interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface KeyUsage extends Totals {
  errors: number;
  cacheHits: number;
  byModel: Map<string, Totals>;
  /** The most recent latencies, used for percentiles. */
  latencies: number[];
}

export interface KeyReport extends Totals {
  errors: number;
  cacheHits: number;
  cacheHitRate: number;
  latencyMs: { p50: number; p95: number };
  byModel: Record<string, Totals>;
}

/** How many recent latencies to keep per key for percentiles. */
const LATENCY_WINDOW = 1000;

const zeroTotals = (): Totals => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

/**
 * In-memory usage ledger per virtual key. It answers two questions:
 * "how much has this key spent?" (for budgets) and "what does usage look like?"
 * (for GET /v1/usage and the dashboard). It resets when the process restarts.
 */
export class UsageMeter {
  private readonly usage = new Map<string, KeyUsage>();
  /** Worst-case cost of requests in flight, per key (see Gateway.admit). */
  private readonly reserved = new Map<string, number>();

  reserve(keyName: string, usd: number): void {
    this.reserved.set(keyName, this.reservedUsd(keyName) + usd);
  }

  release(keyName: string, usd: number): void {
    // Clamp at 0 so floating point leftovers never turn into negative reservations.
    this.reserved.set(keyName, Math.max(0, this.reservedUsd(keyName) - usd));
  }

  reservedUsd(keyName: string): number {
    return this.reserved.get(keyName) ?? 0;
  }

  record(keyName: string, record: UsageRecord): void {
    const usage = this.forKey(keyName);
    addTo(usage, record);
    if (record.cached) usage.cacheHits += 1;

    let model = usage.byModel.get(record.model);
    if (!model) usage.byModel.set(record.model, (model = zeroTotals()));
    addTo(model, record);

    usage.latencies.push(record.latencyMs);
    if (usage.latencies.length > LATENCY_WINDOW) usage.latencies.shift();
  }

  recordError(keyName: string): void {
    this.forKey(keyName).errors += 1;
  }

  spentUsd(keyName: string): number {
    return this.usage.get(keyName)?.costUsd ?? 0;
  }

  report(keyName: string): KeyReport {
    const usage = this.forKey(keyName);
    const sorted = [...usage.latencies].sort((a, b) => a - b);
    return {
      requests: usage.requests,
      errors: usage.errors,
      cacheHits: usage.cacheHits,
      cacheHitRate: usage.requests === 0 ? 0 : usage.cacheHits / usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
      byModel: Object.fromEntries(usage.byModel),
    };
  }

  private forKey(keyName: string): KeyUsage {
    let usage = this.usage.get(keyName);
    if (!usage) {
      usage = { ...zeroTotals(), errors: 0, cacheHits: 0, byModel: new Map(), latencies: [] };
      this.usage.set(keyName, usage);
    }
    return usage;
  }
}

function addTo(totals: Totals, record: UsageRecord): void {
  totals.requests += 1;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.costUsd += record.costUsd;
}

/** Nearest-rank percentile of an already sorted array; 0 for an empty one. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}
