/**
 * Rolling-window crash budget. A source records each fault via
 * {@link record}; once `maxFailures` faults have happened within
 * `windowMs`, the next record() returns `{exhausted: true}` and the
 * caller disables the plugin permanently for this daemon run.
 *
 * Pure logic, no timers — `record(now)` is the only state-changing op.
 * Pass an explicit `now` from tests for determinism; production callers
 * default to `Date.now()`.
 */
export interface CrashBudgetOptions {
  readonly maxFailures: number;
  readonly windowMs: number;
}

export interface CrashBudgetResult {
  /** True if this fault tipped the budget over the edge. */
  readonly exhausted: boolean;
  /** Failures still allowed within the current window. */
  readonly remaining: number;
}

export class CrashBudget {
  private readonly timestamps: number[] = [];
  constructor(private readonly cfg: CrashBudgetOptions) {
    if (cfg.maxFailures <= 0) {
      throw new Error('CrashBudget: maxFailures must be > 0');
    }
    if (cfg.windowMs <= 0) {
      throw new Error('CrashBudget: windowMs must be > 0');
    }
  }

  record(now: number = Date.now()): CrashBudgetResult {
    const cutoff = now - this.cfg.windowMs;
    // Window is [cutoff, now] inclusive — only entries strictly older
    // than the window's start are pruned.
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    this.timestamps.push(now);
    const exhausted = this.timestamps.length >= this.cfg.maxFailures;
    const remaining = Math.max(0, this.cfg.maxFailures - this.timestamps.length);
    return { exhausted, remaining };
  }

  /** Number of failures inside the active window (excludes pruned ones). */
  currentCount(now: number = Date.now()): number {
    const cutoff = now - this.cfg.windowMs;
    let n = 0;
    for (const t of this.timestamps) if (t >= cutoff) n += 1;
    return n;
  }
}
