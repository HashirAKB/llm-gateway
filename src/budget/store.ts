export interface ReserveResult {
  allowed: boolean;
  /** Spend plus in-flight reservations, before this request. */
  committedUsd: number;
}

/**
 * Where per-key spend and in-flight reservations live.
 *
 * Every budgeted request follows the same two steps:
 *   reserve(worst case)  -> allowed only if spend + reservations + worst case <= budget
 *   settle(real cost)    -> the reservation is replaced by the real cost (0 if the request failed)
 * `reserve` must be atomic: two concurrent calls must never both see room for one.
 */
export interface BudgetStore {
  reserve(keyName: string, reservationId: string, usd: number, budgetUsd: number): Promise<ReserveResult>;
  settle(keyName: string, reservationId: string, spentUsd: number): Promise<void>;
  spentUsd(keyName: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Single-instance store. Each method body runs without an `await`, and Node runs
 * one piece of JavaScript at a time, so check-and-reserve is atomic for free.
 * Spend is lost on restart.
 */
export class MemoryBudgetStore implements BudgetStore {
  private readonly spent = new Map<string, number>();
  private readonly reservations = new Map<string, Map<string, number>>();

  async reserve(keyName: string, reservationId: string, usd: number, budgetUsd: number): Promise<ReserveResult> {
    const reserved = this.reservationsFor(keyName);
    const committedUsd = (this.spent.get(keyName) ?? 0) + sum(reserved.values());
    if (committedUsd + usd > budgetUsd) return { allowed: false, committedUsd };
    reserved.set(reservationId, usd);
    return { allowed: true, committedUsd };
  }

  async settle(keyName: string, reservationId: string, spentUsd: number): Promise<void> {
    this.reservationsFor(keyName).delete(reservationId);
    this.spent.set(keyName, (this.spent.get(keyName) ?? 0) + spentUsd);
  }

  async spentUsd(keyName: string): Promise<number> {
    return this.spent.get(keyName) ?? 0;
  }

  async close(): Promise<void> {}

  private reservationsFor(keyName: string): Map<string, number> {
    let reserved = this.reservations.get(keyName);
    if (!reserved) this.reservations.set(keyName, (reserved = new Map()));
    return reserved;
  }
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
