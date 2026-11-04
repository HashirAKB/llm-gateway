import type { Target } from "../config.js";

/**
 * Tracks a smoothed latency per target with an exponentially weighted moving
 * average (EWMA): estimate = estimate + alpha * (sample - estimate).
 * Recent samples count most, old ones fade out, and it needs O(1) memory.
 * With alpha 0.3, a sudden change is mostly reflected after about 5 samples.
 */
export class LatencyTracker {
  private readonly estimates = new Map<string, number>();

  constructor(private readonly alpha = 0.3) {}

  record(target: Target, ms: number): void {
    const id = targetId(target);
    const previous = this.estimates.get(id);
    this.estimates.set(id, previous === undefined ? ms : previous + this.alpha * (ms - previous));
  }

  /** Smoothed latency in ms, or undefined if the target has never succeeded. */
  estimate(target: Target): number | undefined {
    return this.estimates.get(targetId(target));
  }

  /** All estimates, for the metrics gauge. */
  all(): { provider: string; model: string; ms: number }[] {
    return [...this.estimates].map(([id, ms]) => {
      const slash = id.indexOf("/"); // provider names contain no "/", model names might
      return { provider: id.slice(0, slash), model: id.slice(slash + 1), ms };
    });
  }
}

function targetId(target: Target): string {
  return `${target.provider}/${target.model}`;
}
