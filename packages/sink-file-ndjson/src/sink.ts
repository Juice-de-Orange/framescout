import { mkdir } from 'node:fs/promises';
import type {
  PluginContext,
  Sink,
  SinkPayload,
} from '@framescout/plugin-api';
import { Rotator } from './rotation.js';

export interface FileNdjsonSinkConfig {
  /** Directory to write rotated `YYYYMMDD-HH.ndjson` files into. */
  readonly path: string;
  /** Lines per file before rotating; default 1000. */
  readonly rotateLines: number;
  /** Pretty-print JSON (2-space). Default `false` for canonical NDJSON. */
  readonly prettyJson: boolean;
}

/**
 * Wire-format version of NDJSON lines emitted by this sink. Bumped
 * for incompatible structural changes; downstream consumers route on
 * this field.
 */
export const FILE_NDJSON_SCHEMA_VERSION = 1;

/**
 * Append-only local NDJSON sink. One JSON record per Observation
 * (`schemaVersion + observation + allDetections`); rotation rules
 * per `./rotation.ts`. Doubles as the standalone audit log and (in
 * v0.2) the on-disk backend for `overflow: spool-to-disk` sinks.
 */
export class FileNdjsonSink implements Sink {
  private rotator: Rotator | null = null;

  constructor(
    private readonly config: FileNdjsonSinkConfig,
    private readonly ctx: PluginContext,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.config.path, { recursive: true });
    this.rotator = new Rotator({
      dir: this.config.path,
      maxLinesPerFile: this.config.rotateLines,
    });
    this.ctx.logger.info(
      { path: this.config.path, rotateLines: this.config.rotateLines },
      'file-ndjson sink initialised',
    );
  }

  async start(): Promise<void> {
    // No background work — writes happen synchronously in `deliver()`.
  }

  async stop(): Promise<void> {
    const r = this.rotator;
    this.rotator = null;
    if (r) await r.close();
  }

  async deliver(payload: SinkPayload): Promise<void> {
    if (!this.rotator) {
      throw new Error('file-ndjson sink: deliver() called before init()');
    }
    const record = {
      schemaVersion: FILE_NDJSON_SCHEMA_VERSION,
      observation: payload.observation,
      allDetections: payload.allDetections,
    };
    const line = this.config.prettyJson
      ? JSON.stringify(record, null, 2)
      : JSON.stringify(record);
    await this.rotator.writeLine(line);
    this.ctx.metric('observations_written', 1);
  }
}
