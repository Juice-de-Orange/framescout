import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export interface RotatorOptions {
  /** Directory under which rotated files live. Created on demand. */
  readonly dir: string;
  /** Maximum lines per file in this process before rotating. */
  readonly maxLinesPerFile: number;
  /**
   * Clock source — defaults to `Date.now`. Tests inject a fake clock
   * to step the hour deterministically.
   */
  readonly now?: () => number;
}

/**
 * Append-only rolling-NDJSON writer. Files are named `YYYYMMDD-HH.ndjson`
 * in UTC. Rotation triggers on either:
 *   1. The local clock crossing into a new UTC hour, or
 *   2. The session-local line counter reaching `maxLinesPerFile`.
 *
 * The line counter is reset on every rotate, so daemon restarts open
 * a fresh counter against the same hour file — pre-existing lines in
 * the file are not counted. The v0.2 spool-to-disk backend uses its
 * own counter that *does* persist across restarts.
 */
export class Rotator {
  private file: FileHandle | null = null;
  private currentKey: string | null = null;
  private currentLines = 0;
  private readonly nowFn: () => number;

  constructor(private readonly opts: RotatorOptions) {
    this.nowFn = opts.now ?? Date.now;
  }

  async writeLine(line: string): Promise<void> {
    const key = hourKey(this.nowFn());
    if (
      this.file === null ||
      key !== this.currentKey ||
      this.currentLines >= this.opts.maxLinesPerFile
    ) {
      await this.openFor(key);
    }
    await this.file!.write(`${line}\n`);
    this.currentLines += 1;
  }

  async close(): Promise<void> {
    const f = this.file;
    this.file = null;
    this.currentKey = null;
    this.currentLines = 0;
    if (f) await f.close();
  }

  private async openFor(key: string): Promise<void> {
    if (this.file) await this.file.close();
    await mkdir(this.opts.dir, { recursive: true });
    this.file = await open(join(this.opts.dir, `${key}.ndjson`), 'a');
    this.currentKey = key;
    this.currentLines = 0;
  }
}

/**
 * UTC `YYYYMMDD-HH` from an epoch millis value.
 */
export function hourKey(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}`;
}
