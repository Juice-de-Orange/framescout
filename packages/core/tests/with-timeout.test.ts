import { describe, expect, it, vi } from 'vitest';

import { TimeoutError, withTimeout } from '../src/utils/with-timeout.js';

describe('withTimeout', () => {
  it('resolves with the inner promise value when it wins the race', async () => {
    const value = await withTimeout(Promise.resolve(42), 100, 'fast');
    expect(value).toBe(42);
  });

  it('rejects with TimeoutError when the deadline wins', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    await expect(withTimeout(slow, 10, 'slow')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError carries the label and timeoutMs', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await withTimeout(slow, 5, 'detector x.detect()');
      expect.fail('expected TimeoutError');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).label).toBe('detector x.detect()');
      expect((err as TimeoutError).timeoutMs).toBe(5);
      expect((err as TimeoutError).message).toContain('5ms');
    }
  });

  it('fires onTimeout exactly once when the deadline wins', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    const onTimeout = vi.fn();
    await expect(withTimeout(slow, 5, 'x', { onTimeout })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not fire onTimeout when the inner promise wins', async () => {
    const onTimeout = vi.fn();
    await withTimeout(Promise.resolve(1), 50, 'x', { onTimeout });
    // give the (cleared) timer a tick to prove it really doesn't fire
    await new Promise((r) => setTimeout(r, 10));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('treats timeoutMs <= 0 as "no deadline"', async () => {
    const value = await withTimeout(Promise.resolve('ok'), 0, 'x');
    expect(value).toBe('ok');
  });

  it('treats non-finite timeoutMs as "no deadline"', async () => {
    const value = await withTimeout(
      Promise.resolve('ok'),
      Number.POSITIVE_INFINITY,
      'x',
    );
    expect(value).toBe('ok');
  });

  it('does not surface a late inner rejection as unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const lateReject = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('late')), 30),
    );
    await expect(withTimeout(lateReject, 5, 'x')).rejects.toBeInstanceOf(TimeoutError);
    await new Promise((r) => setTimeout(r, 60));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
