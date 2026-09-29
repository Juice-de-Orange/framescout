import { describe, expect, it } from 'vitest';

import { CrashBudget } from '../src/utils/crash-budget.js';

describe('CrashBudget', () => {
  it('does not exhaust before maxFailures', () => {
    const budget = new CrashBudget({ maxFailures: 3, windowMs: 1_000 });
    expect(budget.record(0)).toEqual({ exhausted: false, remaining: 2 });
    expect(budget.record(100)).toEqual({ exhausted: false, remaining: 1 });
  });

  it('exhausts on the maxFailures-th hit inside the window', () => {
    const budget = new CrashBudget({ maxFailures: 3, windowMs: 1_000 });
    budget.record(0);
    budget.record(100);
    expect(budget.record(200)).toEqual({ exhausted: true, remaining: 0 });
  });

  it('prunes timestamps older than windowMs (rolling-window semantics)', () => {
    const budget = new CrashBudget({ maxFailures: 3, windowMs: 1_000 });
    budget.record(0);
    budget.record(500);
    // 1_500 prunes the t=0 entry; remaining inside-window is 1 + this new one = 2
    expect(budget.record(1_500)).toEqual({ exhausted: false, remaining: 1 });
  });

  it('remaining = 0 once exhausted; subsequent records stay exhausted', () => {
    const budget = new CrashBudget({ maxFailures: 2, windowMs: 1_000 });
    budget.record(0);
    expect(budget.record(100)).toEqual({ exhausted: true, remaining: 0 });
    expect(budget.record(200)).toEqual({ exhausted: true, remaining: 0 });
  });

  it('recovers when old failures age out and a new one lands alone', () => {
    const budget = new CrashBudget({ maxFailures: 2, windowMs: 1_000 });
    budget.record(0);
    budget.record(500); // exhausted
    // jump past the window — both old entries are pruned, new one stands alone
    expect(budget.record(2_000)).toEqual({ exhausted: false, remaining: 1 });
  });

  it('currentCount reflects only in-window failures', () => {
    const budget = new CrashBudget({ maxFailures: 5, windowMs: 1_000 });
    budget.record(0);
    budget.record(500);
    budget.record(900);
    expect(budget.currentCount(1_500)).toBe(2);
  });

  it('rejects non-positive config', () => {
    expect(() => new CrashBudget({ maxFailures: 0, windowMs: 1 })).toThrow();
    expect(() => new CrashBudget({ maxFailures: 1, windowMs: 0 })).toThrow();
  });
});
