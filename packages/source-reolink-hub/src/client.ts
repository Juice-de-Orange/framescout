import { z } from 'zod';
import type { Logger } from '@framescout/plugin-api';
import {
  dateToHubParts,
  hubPartsToDate,
  type HubTimeParts,
} from './time.js';

/** Shape every Reolink response uses: a JSON array of `{ code, value, error? }`. */
const ReolinkResponseSchema = z.array(
  z.object({
    code: z.number().optional(),
    value: z.unknown().optional(),
    error: z.unknown().optional(),
  }),
);

const LoginValueSchema = z.object({
  Token: z.object({
    name: z.string(),
    leaseTime: z.number().optional(),
  }),
});

const HubTimePartsSchema = z.object({
  year: z.number(),
  mon: z.number(),
  day: z.number(),
  hour: z.number(),
  min: z.number(),
  sec: z.number(),
});

const SearchFileSchema = z.object({
  name: z.string(),
  StartTime: HubTimePartsSchema,
  EndTime: HubTimePartsSchema,
  type: z.string().optional(),
});

const SearchValueSchema = z
  .object({
    SearchResult: z
      .object({
        File: z.array(SearchFileSchema).optional(),
      })
      .optional(),
  })
  .nullable();

export interface ReolinkClipEvent {
  /** Channel index on the Hub (0-based). */
  readonly channel: number;
  /** Stable id for dedup; the Hub's filename. */
  readonly eventId: string;
  readonly capturedAt: Date;
  readonly endsAt: Date;
  /** Raw type tag from `Search` ('animal', 'pet', 'motion', …) — uppercased by Reolink. */
  readonly tag: string;
}

export interface ReolinkClientOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly httpTimeoutMs: number;
  readonly downloadTimeoutMs: number;
  readonly logger: Logger;
  /** Defaults to global `fetch`. Tests inject a mock. */
  readonly fetchFn?: typeof fetch;
}

/**
 * Minimal Reolink Hub HTTP client — login (token-in-URL with 3600 s
 * lease), search (per-channel time-window query for recorded clips),
 * download (URL-mints; ffmpeg can fetch directly).
 *
 * Ported from the seed Bridge's `src/reolink.ts`; trimmed down to the
 * subset Framescout v0.1 needs (no Snap path; the Hub Mini B001
 * snap-startTime bug is documented but not used).
 */
export class ReolinkClient {
  private token: string | null = null;
  private tokenExpiry = 0;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ReolinkClientOptions) {
    this.base = `${opts.baseUrl.replace(/\/$/, '')}/api.cgi`;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Verify login works. Forces a fresh token. */
  async ping(): Promise<void> {
    this.token = null;
    this.tokenExpiry = 0;
    await this.login();
  }

  /**
   * Return clip events on `channel` recorded between `since` and now.
   * `filter` lets callers restrict by Reolink's `type` / `name` tag
   * (e.g., AI-animal events only).
   */
  async search(
    channel: number,
    since: Date,
    filter: (tag: string) => boolean,
  ): Promise<readonly ReolinkClipEvent[]> {
    const value = await this.request('Search', {
      Search: {
        channel,
        onlyStatus: 0,
        streamType: 'main',
        StartTime: dateToHubParts(since),
        EndTime: dateToHubParts(new Date()),
      },
    });
    const parsed = SearchValueSchema.parse(value);
    const files = parsed?.SearchResult?.File ?? [];
    const events: ReolinkClipEvent[] = [];
    for (const file of files) {
      const tag = (file.type ?? file.name).toLowerCase();
      if (!filter(tag)) continue;
      events.push({
        channel,
        eventId: file.name,
        capturedAt: hubPartsToDate(file.StartTime),
        endsAt: hubPartsToDate(file.EndTime),
        tag,
      });
    }
    return events;
  }

  /**
   * Build the download URL for a clip. We embed the current token; the
   * caller passes this URL to ffmpeg (via CaptureEvent.clip.url).
   * Tokens have a 3600 s lease, which is plenty for the seconds
   * between Source-emit and decode-stage fetch.
   */
  async downloadUrl(fileName: string): Promise<string> {
    if (Date.now() > this.tokenExpiry) await this.login();
    const encodedSource = encodeURIComponent(fileName).replace(/%2F/g, '/');
    const filename = fileName.split('/').pop() ?? 'clip.mp4';
    return (
      `${this.base}?cmd=Download` +
      `&source=${encodedSource}` +
      `&output=${encodeURIComponent(filename)}` +
      `&token=${this.token}`
    );
  }

  private async request(
    cmd: string,
    params: unknown,
    retried = false,
  ): Promise<unknown> {
    if (Date.now() > this.tokenExpiry) await this.login();
    const url = `${this.base}?cmd=${cmd}&token=${this.token}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ cmd, action: 0, param: params }]),
      signal: AbortSignal.timeout(this.opts.httpTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`reolink HTTP ${res.status} for cmd=${cmd}`);
    }
    const parsed = ReolinkResponseSchema.parse(await res.json());
    const first = parsed[0];
    // Code -6 = token expired (typical Reolink). Re-login once and retry.
    if (first?.code === -6 && !retried) {
      this.token = null;
      this.tokenExpiry = 0;
      return this.request(cmd, params, true);
    }
    if (first?.code !== 0) {
      throw new Error(`reolink error code ${first?.code} for cmd=${cmd}`);
    }
    return first.value;
  }

  private async login(): Promise<void> {
    const url = `${this.base}?cmd=Login`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          cmd: 'Login',
          action: 0,
          param: {
            User: {
              userName: this.opts.username,
              password: this.opts.password,
              Version: '0',
            },
          },
        },
      ]),
      signal: AbortSignal.timeout(this.opts.httpTimeoutMs),
    });
    if (!res.ok) throw new Error(`reolink login HTTP ${res.status}`);
    const parsed = ReolinkResponseSchema.parse(await res.json());
    const first = parsed[0];
    if (first?.code !== 0) {
      throw new Error(`reolink login failed: code ${first?.code}`);
    }
    const value = LoginValueSchema.parse(first.value);
    this.token = value.Token.name;
    const lease = value.Token.leaseTime ?? 3600;
    this.tokenExpiry = Date.now() + (lease - 60) * 1000;
    this.opts.logger.info(
      { leaseSeconds: lease, baseUrl: this.opts.baseUrl },
      'reolink: login successful',
    );
  }
}

export { type HubTimeParts, dateToHubParts, hubPartsToDate };

/**
 * Default tag filter used when `aiOnly: true`. Liberal: includes any
 * AI-tagged animal/pet/dog/cat events. Users on quieter setups can
 * tighten via plugin updates if needed.
 */
export function isAnimalTag(tag: string): boolean {
  return (
    tag.includes('animal') ||
    tag.includes('pet') ||
    tag.includes('dog') ||
    tag.includes('cat')
  );
}
