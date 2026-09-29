/**
 * Merge several `AsyncIterable<T>` into one, yielding values in
 * arrival order (round-robin under load). Implementation detail: a
 * `Promise.race` over each iterator's `.next()`. When one iterator
 * finishes, it's removed; when all finish, the merged generator ends.
 *
 * The `signal` argument cancels: subsequent values are not yielded
 * once it fires, and any pending `.next()` is allowed to settle but
 * its result is dropped.
 */
export async function* mergeAsyncIterables<T>(
  iterables: readonly AsyncIterable<T>[],
  signal: AbortSignal,
): AsyncGenerator<T, void, void> {
  if (iterables.length === 0) return;

  type Entry = {
    iter: AsyncIterator<T, unknown, undefined>;
    pending: Promise<{ index: number; result: IteratorResult<T, unknown> }>;
    index: number;
  };

  const entries: Entry[] = iterables.map((it, index) => {
    const iter = it[Symbol.asyncIterator]();
    const pending = iter
      .next()
      .then((result) => ({ index, result }));
    return { iter, pending, index };
  });

  while (entries.length > 0) {
    if (signal.aborted) return;

    const settled = await Promise.race(entries.map((e) => e.pending));
    const entry = entries.find((e) => e.index === settled.index);
    if (!entry) continue;

    if (settled.result.done) {
      // Iterator exhausted; remove from rotation.
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      continue;
    }

    yield settled.result.value;

    if (signal.aborted) return;
    entry.pending = entry.iter
      .next()
      .then((result) => ({ index: entry.index, result }));
  }
}
