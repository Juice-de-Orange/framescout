import { setTimeout as wait } from 'node:timers/promises';
import type {
  CaptureEvent,
  Logger,
  PluginContext,
  Source,
} from '@framescout/plugin-api';

import {
  ReolinkClient,
  isAnimalTag,
  type ReolinkClipEvent,
} from './client.js';
import { SourceState } from './state.js';

export interface ReolinkChannel {
  readonly channel: number;
  readonly deploymentId: string;
  readonly cameraId: string;
  /** `true` (default) → AI-tagged animal events only. */
  readonly aiOnly: boolean;
}

export interface ReolinkHubConfig {
  readonly baseUrl: string;
  readonly username: string;
  /** Env var that holds the password. Read once at init() (ARCH §10). */
  readonly passwordEnv: string;
  readonly channels: readonly ReolinkChannel[];
  /** Default 15_000 ms (15 s) per V0.1-SCOPE example config. */
  readonly pollIntervalMs: number;
  /** First-run lookback: how far back to search initially. Default 1 h. */
  readonly initialLookbackMs: number;
  readonly httpTimeoutMs: number;
  readonly downloadTimeoutMs: number;
}

/**
 * Reolink Hub Mini / Home Hub / RLN-NVR source plugin. Polls each
 * configured channel for new recorded clips, mints a CaptureEvent
 * with the Hub's `cmd=Download` URL (ffmpeg fetches directly during
 * the decode stage), and persists per-channel watermarks to
 * `ctx.dataDir/state.json` so daemon restarts resume cleanly.
 */
export class ReolinkSource implements Source {
  private client: ReolinkClient | null = null;
  private state: SourceState;
  private readonly log: Logger;

  constructor(
    private readonly config: ReolinkHubConfig,
    private readonly ctx: PluginContext,
  ) {
    this.state = new SourceState(ctx.dataDir);
    this.log = ctx.logger;
  }

  async init(): Promise<void> {
    const password = process.env[this.config.passwordEnv];
    if (!password) {
      throw new Error(
        `reolink-hub: passwordEnv "${this.config.passwordEnv}" is empty`,
      );
    }
    this.client = new ReolinkClient({
      baseUrl: this.config.baseUrl,
      username: this.config.username,
      password,
      httpTimeoutMs: this.config.httpTimeoutMs,
      downloadTimeoutMs: this.config.downloadTimeoutMs,
      logger: this.log,
    });
    await this.client.ping();
    await this.state.load();
    this.log.info(
      {
        baseUrl: this.config.baseUrl,
        channels: this.config.channels.length,
        pollIntervalMs: this.config.pollIntervalMs,
      },
      'reolink-hub source initialised',
    );
  }

  async start(): Promise<void> {
    // Polling happens in events(); start() is a no-op.
  }

  async stop(): Promise<void> {
    // Persist state on graceful shutdown.
    try {
      await this.state.save();
    } catch (err) {
      this.log.warn({ err }, 'reolink-hub: failed to save state on stop');
    }
  }

  events(): AsyncIterable<CaptureEvent> {
    return this.poll();
  }

  private async *poll(): AsyncGenerator<CaptureEvent, void, void> {
    if (!this.client) throw new Error('reolink-hub: events() called before init()');
    const signal = this.ctx.abortSignal;

    while (!signal.aborted) {
      for (const channel of this.config.channels) {
        if (signal.aborted) return;
        try {
          for await (const ev of this.pollChannel(channel)) {
            if (signal.aborted) return;
            yield ev;
          }
          await this.state.save();
        } catch (err) {
          this.ctx.metric('poll_errors', 1, {
            channel: String(channel.channel),
          });
          this.log.warn(
            { err, channel: channel.channel },
            'reolink-hub: poll failed; retrying after interval',
          );
        }
      }

      // Sleep until next poll, but cooperate with abort.
      try {
        await wait(this.config.pollIntervalMs, undefined, { signal });
      } catch {
        return; // aborted
      }
    }
  }

  private async *pollChannel(
    channel: ReolinkChannel,
  ): AsyncGenerator<CaptureEvent, void, void> {
    if (!this.client) return;
    const since =
      this.state.getLastSeen(channel.channel) ??
      new Date(Date.now() - this.config.initialLookbackMs);

    const filter = channel.aiOnly ? isAnimalTag : (): boolean => true;
    const clips = await this.client.search(channel.channel, since, filter);
    this.ctx.metric('clips_fetched', clips.length, {
      channel: String(channel.channel),
    });

    // Sort by capturedAt to yield in chronological order.
    const sorted = [...clips].sort(
      (a, b) => a.capturedAt.getTime() - b.capturedAt.getTime(),
    );

    let maxEnd = since;
    for (const clip of sorted) {
      const url = await this.client.downloadUrl(clip.eventId);
      yield this.toCaptureEvent(clip, channel, url);
      if (clip.endsAt > maxEnd) maxEnd = clip.endsAt;
    }
    if (maxEnd > since) this.state.setLastSeen(channel.channel, maxEnd);
  }

  private toCaptureEvent(
    clip: ReolinkClipEvent,
    channel: ReolinkChannel,
    downloadUrl: string,
  ): CaptureEvent {
    return {
      eventId: clip.eventId,
      capturedAt: clip.capturedAt.toISOString(),
      endsAt: clip.endsAt.toISOString(),
      cameraId: channel.cameraId,
      deploymentId: channel.deploymentId,
      clip: { kind: 'url', url: downloadUrl },
      meta: {
        reolink: {
          channel: clip.channel,
          tag: clip.tag,
        },
      },
    };
  }
}
