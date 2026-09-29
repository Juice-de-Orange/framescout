/**
 * Three-state circuit breaker per `ARCHITECTURE.md §6.5`:
 *
 *   closed  → failureThreshold consecutive failures → open
 *   open    → cooldownMs elapsed                    → half-open
 *   half-open → single probe:
 *       success                                    → closed
 *       failure                                    → open
 *
 * The probe slot ensures only one in-flight delivery during half-open.
 * Subsequent `canPass()` calls return `false` until the probe completes
 * (success or failure recorded).
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures that opens the breaker. */
  readonly failureThreshold: number;
  /** Time to stay open before moving to half-open. */
  readonly cooldownMs: number;
  /** Injected for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly nowFn: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.nowFn = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Reserves a delivery slot. Returns `true` when the caller may proceed.
   * In half-open this consumes the single probe slot; further
   * `canPass()` calls return `false` until the caller records success or
   * failure.
   */
  canPass(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (this.nowFn() - this.openedAt < this.opts.cooldownMs) return false;
      this.state = 'half-open';
      this.probeInFlight = false;
    }

    // half-open path
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.probeInFlight = false;
    if (
      this.state === 'half-open' ||
      this.consecutiveFailures >= this.opts.failureThreshold
    ) {
      this.state = 'open';
      this.openedAt = this.nowFn();
    }
  }
}
