import { watch, type FSWatcher } from 'chokidar';

/**
 * Debounced chokidar watcher for an individual-recognition reference
 * directory. Fires `onChange` once per quiescent burst — drag-dropping
 * 10 photos in 2 seconds triggers one reload, not ten.
 *
 * Returns an FSWatcher the caller closes during plugin stop().
 */
export interface StartWatcherOptions {
  /** Debounce window in ms; collapse changes that land within this. */
  readonly debounceMs?: number;
  /** Optional logger; only `debug` is used. */
  readonly logger?: { debug: (obj: object, msg: string) => void };
}

export function startWatcher(
  referenceDir: string,
  onChange: () => Promise<void>,
  opts: StartWatcherOptions = {},
): FSWatcher {
  const debounceMs = opts.debounceMs ?? 500;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastFire = 0;

  const schedule = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      lastFire = Date.now();
      void onChange().catch((err: unknown) => {
        opts.logger?.debug(
          { err },
          'individuals: reloadCentroids() rejected during watch',
        );
      });
    }, debounceMs);
  };

  const watcher = watch(referenceDir, {
    ignored: /(^|[\\/])\.[^.\\/]/, // dotfiles
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  const handler = (path: string): void => {
    opts.logger?.debug({ path, lastFire }, 'individuals: change event');
    schedule();
  };
  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', handler);
  watcher.on('addDir', handler);
  watcher.on('unlinkDir', handler);

  return watcher;
}
