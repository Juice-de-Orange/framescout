# Plugin Author Guide

How to ship a `Source`, `Detector`, or `Sink` plugin for Framescout
v0.1. The plugin contract lives in `@framescout/plugin-api` and is
documented architecturally in `docs/ARCHITECTURE.md §5`. This page
walks through the practical mechanics: package layout, manifest
field, factory shape, and a worked end-to-end example
(`framescout-sink-discord`).

## What is a Framescout plugin?

An npm package that:

1. Carries a `framescout` field in its `package.json` with version-,
   kind- and identity-metadata (read by the loader **before** any
   plugin code executes).
2. Default-exports (or named-exports `factory`) a `PluginFactory<TConfig,
   TPlugin>` whose `manifest` matches the package.json one.
3. Returns plugin instances that satisfy one of the three plugin
   interfaces — `Source`, `Detector`, or `Sink`.

Plugins **are not sandboxed** (ARCH §10). The trust model is
"audit your lockfile, pin versions you trust" — same as n8n / ESLint
and most of the Node ecosystem.

## Anatomy of a plugin package

```
framescout-sink-discord/
├── package.json
├── src/
│   ├── index.ts         # factory + zod schema
│   └── sink.ts          # DiscordSink class
├── tests/
│   └── sink.test.ts
├── tsconfig.json
└── README.md
```

### `package.json`

```json
{
  "name": "framescout-sink-discord",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "framescout": {
    "apiVersion": "^0.1.0",
    "kind": "sink",
    "id": "discord",
    "displayName": "Discord Webhook"
  },
  "peerDependencies": {
    "@framescout/plugin-api": "^0.1.0"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "files": ["dist", "README.md"]
}
```

The package name doesn't have to be in the `@framescout` scope —
`framescout-plugin-foo` and `@your-scope/framescout-plugin-foo` work
identically. The naming convention is for humans browsing npm; the
loader keys off the `framescout` field.

**Stability advice:**
- Pin the `peerDependencies` range tightly while the API is pre-1.0
  (we recommend `^0.1.0`, not `>=0.1.0`).
- When `@framescout/plugin-api` bumps a minor pre-1.0, your plugin
  needs a new release.

### Factory

```ts
// src/index.ts
import { z } from 'zod';
import type {
  PluginContext,
  PluginFactory,
  PluginManifest,
} from '@framescout/plugin-api';
import { DiscordSink, type DiscordConfig } from './sink.js';

const configSchema = z.object({
  webhookUrl: z.string().url(),
  username: z.string().default('framescout'),
  timeoutMs: z.number().int().positive().default(10_000),
});

const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'sink',
  id: 'discord',
  displayName: 'Discord Webhook',
};

const factory: PluginFactory<DiscordConfig, DiscordSink> = {
  manifest,
  configSchema,
  create: (config, ctx) => new DiscordSink(config, ctx),
};

export default factory;
```

The `manifest.id` **must** match `package.json["framescout"].id` —
the loader checks this for defence-in-depth against accidental
mismatches.

### The plugin class

```ts
// src/sink.ts
import type {
  PluginContext,
  Sink,
  SinkPayload,
} from '@framescout/plugin-api';

export interface DiscordConfig {
  webhookUrl: string;
  username: string;
  timeoutMs: number;
}

export class DiscordSink implements Sink {
  constructor(
    private readonly config: DiscordConfig,
    private readonly ctx: PluginContext,
  ) {}

  // A rejecting init() of a source or sink is not fatal: the daemon
  // calls it again with backoff until it resolves, so it must be safe
  // to call again. Throw from the factory's create() instead for a
  // configuration problem that retrying cannot fix.
  async init(): Promise<void> {
    this.ctx.logger.info('discord sink initialised');
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async deliver(payload: SinkPayload, signal: AbortSignal): Promise<void> {
    const message = formatMessage(payload);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('discord timeout')),
      this.config.timeoutMs,
    );
    signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.config.username, content: message }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`discord ${res.status}: ${await res.text()}`);
      }
      await res.text().catch(() => undefined); // drain
      this.ctx.metric('deliveries', 1, { outcome: 'success' });
    } catch (err) {
      this.ctx.metric('deliveries', 1, { outcome: 'error' });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function formatMessage(payload: SinkPayload): string {
  const o = payload.observation;
  const species = o.scientificName ?? o.observationType;
  return `🦊 ${species} (${(o.classificationProbability ?? 0).toFixed(2)}) at ${o.deploymentId}/${o.cameraId ?? '?'}`;
}
```

## The three plugin interfaces

### `Source`

```ts
export interface Source extends PluginLifecycle {
  events(): AsyncIterable<CaptureEvent>;
}
```

Push-based sources keep an internal queue and yield from it; pull-
based sources await between polls. Either way, the iterator must
honour `ctx.abortSignal` and complete cleanly on shutdown. State
persistence (last-poll timestamps, etc.) is your responsibility —
`ctx.dataDir` is yours to write into.

**Iterator throws are recoverable.** If your `events()` iterator
throws (network drop, NVR returns a bad payload, etc.), the host
catches it, charges one strike against the rolling crash budget
(`framescout.crashBudget` — default 5 failures per 5 minutes), waits
`reinitDelayMs`, and calls `events()` again for a fresh iterator. So:

- Throw on recoverable faults you want re-tried (HTTP 503 from the
  hub, transient socket error).
- Eat-and-retry inside the iterator for *expected* hiccups that
  shouldn't count against the budget (poll returned 0 clips, etc.).
- The budget exhausting flips
  `framescout_plugin_disabled{plugin,kind="source"}` to 1 and stops
  asking your source for events for the rest of the process lifetime.
  Surviving sources keep running.

### `Detector`

```ts
export interface Detector extends PluginLifecycle {
  detect(input: DetectorInput, signal: AbortSignal): Promise<readonly Detection[]>;
}
```

Detectors are stateless from the host's POV — keep all state in the
closure. `DetectorInput.previousDetections` carries the upstream
detector's output (v0.1 chains in YAML declaration order). Use
`signal` for per-call timeouts.

### `Sink`

```ts
export interface Sink extends PluginLifecycle {
  deliver(payload: SinkPayload, signal: AbortSignal): Promise<void>;
}
```

Throw on transient failure — the host's `BoundedSinkWrapper` retries
via the circuit-breaker policy. Return cleanly on success.

## `PluginContext` capabilities

Host gives every plugin instance:

| Field          | Description |
|----------------|-------------|
| `instanceId`   | Operator-chosen id (unique). Use it in log fields, dataDir paths. |
| `logger`       | pino child logger pre-bound to `instanceId` + `pluginKind`. Use `ctx.logger.info({ foo })` — structured JSON only. |
| `dataDir`      | `<runtimeDataDir>/<instanceId>/`. Created on demand. Persists across restarts. Plugin owns the on-disk schema. |
| `abortSignal`  | Fires on graceful shutdown. Wrap iterators / awaits in this. |
| `metric()`     | `(name, value, tags?)` → records a Prometheus counter under `framescout_plugin_<name>_total`. Keep label cardinality low. |

You **must not** import a global logger, share state across plugin
instances, or rely on module-load-order side effects — the loader
dynamic-imports your code and the daemon runs many instances in one
process. Stateless plugin code + per-instance context is the only
contract.

## State migration

If your plugin persists state to `ctx.dataDir`, include a
`schemaVersion` field in the on-disk shape. On `init()`:

1. Try to read the state file.
2. If `schemaVersion` matches what you support, use it.
3. If older, migrate (or warn + start fresh).
4. If unknown / future, refuse to start with a clear error.

The host won't migrate for you (ARCH §5.2 — "state migration is the
plugin author's responsibility").

## Publishing

For npm:

```bash
pnpm publish --access public
```

For a private registry, set `publishConfig.registry`. The
`provenance: true` flag in `publishConfig` enables npm's supply-chain
attestations when published from GitHub Actions with
`id-token: write`.

For users to install your plugin alongside Framescout:

```bash
# In their daemon image's Dockerfile
RUN pnpm add framescout-sink-discord
```

Then reference it from `config.yaml`:

```yaml
sinks:
  - id: discord
    package: framescout-sink-discord
    config:
      webhookUrl: https://discord.com/api/webhooks/.../...
```

## Discoverability

The plan is a **curated discoverability list** in the docs
(not a marketplace) where reviewed plugins are linked — ROADMAP v1.x.
Until then, the convention is the npm naming pattern
`framescout-plugin-*` so users can find plugins via
`npm search framescout-plugin`.

## Worked example: end-to-end

A complete `framescout-sink-discord` starter lives in the
[`examples/`](https://github.com/Juice-de-Orange/framescout/tree/main/examples)
directory (lands with v0.1). Use it as your scaffold — it includes
the tsconfig, vitest config, the tests, and a CI workflow that
publishes on tag.

## Where to ask questions

- Bug reports / RFCs: GitHub issues on `Juice-de-Orange/framescout`.
- Plugin-author Q&A: tag your post with `framescout-plugin` on
  GitHub Discussions.
- Conventions / design questions: ARCHITECTURE.md is the
  single-source-of-truth; if it doesn't answer your question, that's
  worth a discussion thread.
