import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

interface PersistedState {
  readonly schemaVersion: 1;
  readonly lastSeenByChannel: Readonly<Record<string, string>>;
}

/**
 * Per-instance state file under `ctx.dataDir`. Records the most-recent
 * clip end-timestamp seen per channel so daemon restarts pick up
 * approximately where they left off (deduped via Hub `eventId`).
 *
 * Plugins own the on-disk schema. v0.1 stores `schemaVersion: 1`; if
 * a future v0.2 changes the shape, `loadState()` reads `schemaVersion`
 * and migrates (or starts fresh + warns), per ARCH §5.2.
 */
export class SourceState {
  private state: PersistedState;
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'state.json');
    this.state = { schemaVersion: 1, lastSeenByChannel: {} };
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(text) as { schemaVersion?: number };
      if (parsed.schemaVersion === 1) {
        this.state = parsed as PersistedState;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // First run — no state file yet; defaults already initialised.
    }
  }

  getLastSeen(channel: number): Date | undefined {
    const raw = this.state.lastSeenByChannel[String(channel)];
    return raw ? new Date(raw) : undefined;
  }

  setLastSeen(channel: number, when: Date): void {
    this.state = {
      schemaVersion: 1,
      lastSeenByChannel: {
        ...this.state.lastSeenByChannel,
        [String(channel)]: when.toISOString(),
      },
    };
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await rename(tmp, this.path);
  }
}
