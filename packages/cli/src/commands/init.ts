import { existsSync } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Document } from 'yaml';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';
import { defaultPrompter, type Prompter } from '../prompter.js';

const SOURCE_REOLINK = '@framescout/source-reolink-hub';
const DETECTOR_MEGADETECTOR = '@framescout/detector-megadetector-http';
const DETECTOR_DEEPFAUNE = '@framescout/detector-deepfaune-http';
const SINK_HTTP_MULTIPART = '@framescout/sink-http-multipart';
const SINK_MQTT = '@framescout/sink-mqtt';
const SINK_WEBHOOK = '@framescout/sink-webhook';
const SINK_FILE_NDJSON = '@framescout/sink-file-ndjson';

export interface CmdInitOptions {
  /** Destination config path; default `./config.yaml`. */
  readonly path: string;
  /**
   * When true, an existing file at `path` is overwritten without
   * confirmation (useful for non-interactive CI use).
   */
  readonly force?: boolean;
}

/**
 * `framescout init` — interactive scaffold of `config.yaml`.
 *
 * Collects deployment + camera identity, picks a Source / Detector /
 * Sink mix, and renders a valid YAML config that references every secret
 * by environment-variable name (`passwordEnv`, `apiKeyEnv`, …). Atomic write (tmp + rename) so a Ctrl-C mid-prompt
 * never leaves a half-written file. Echoes a tiny `.env.example`
 * snippet at the end so the operator knows which env vars to export.
 */
export async function cmdInit(
  opts: CmdInitOptions,
  io: CliIO,
  prompter: Prompter = defaultPrompter,
): Promise<number> {
  const targetPath = resolve(opts.path);

  // 1) Overwrite-confirm if the file already exists.
  if (existsSync(targetPath) && !opts.force) {
    const ok = await prompter.confirm({
      message: `${targetPath} already exists. Overwrite?`,
      default: false,
    });
    if (!ok) {
      io.out('init aborted — existing file preserved.\n');
      return ExitCode.Success;
    }
  }

  // 2) Deployment + camera identity.
  io.out('framescout init — answer a few questions to scaffold config.yaml.\n\n');

  const deploymentId = await prompter.input({
    message: 'Deployment id (used as deploymentId in CaptureEvent):',
    default: 'home',
    validate: nonEmpty,
  });
  const cameraId = await prompter.input({
    message: 'Camera id (used as cameraId in CaptureEvent):',
    default: 'front-yard',
    validate: nonEmpty,
  });

  // 3) Source — only Reolink Hub in v0.1.
  const sourcePkg = await prompter.select({
    message: 'Source plugin:',
    choices: [
      {
        name: 'Reolink Hub Mini / Home Hub / RLN-series NVR',
        value: SOURCE_REOLINK,
      },
    ],
    default: SOURCE_REOLINK,
  });
  const hubBaseUrl = await prompter.input({
    message: 'Reolink hub base URL:',
    default: 'https://192.0.2.50',
    validate: (v) => /^https?:\/\//.test(v) || 'expected http(s):// URL',
  });
  const hubUsername = await prompter.input({
    message: 'Reolink username:',
    default: 'admin',
    validate: nonEmpty,
  });
  await prompter.password({
    // The actual value is never written to config; the env-var reference is.
    // Asking confirms the operator has the password handy.
    message: 'Reolink password (paste — will not be stored in YAML):',
    validate: nonEmpty,
  });
  const channel = await prompter.input({
    message: 'Hub channel number for this camera:',
    default: '0',
    validate: (v) => /^\d+$/.test(v) || 'expected a non-negative integer',
  });
  const pollIntervalMs = await prompter.input({
    message: 'Hub poll interval (ms):',
    default: '15000',
    validate: (v) => /^[1-9]\d*$/.test(v) || 'expected a positive integer',
  });

  // 4) Detector picks.
  const detectorPicks = await prompter.checkbox({
    message: 'Detector plugins to enable:',
    choices: [
      {
        name: 'MegaDetector (HTTP)',
        value: DETECTOR_MEGADETECTOR,
        checked: true,
        description: 'Animal / person / vehicle bounding boxes.',
      },
      {
        name: 'DeepFaune (HTTP) — non-commercial weights',
        value: DETECTOR_DEEPFAUNE,
        checked: false,
        description: 'European mammal species classifier.',
      },
    ],
  });
  let megadetectorEndpoint = '';
  let deepfauneEndpoint = '';
  let deepfauneNcAcknowledged = false;
  if (detectorPicks.includes(DETECTOR_MEGADETECTOR)) {
    megadetectorEndpoint = await prompter.input({
      message: 'MegaDetector HTTP endpoint:',
      default: 'http://localhost:8001',
      validate: (v) => /^https?:\/\//.test(v) || 'expected http(s):// URL',
    });
  }
  if (detectorPicks.includes(DETECTOR_DEEPFAUNE)) {
    deepfauneNcAcknowledged = await prompter.confirm({
      message:
        'DeepFaune weights are CC BY-NC-SA 4.0 (non-commercial). Acknowledged?',
      default: false,
    });
    if (!deepfauneNcAcknowledged) {
      io.err(
        'DeepFaune detector requires acknowledging the non-commercial license — aborting.\n',
      );
      return ExitCode.Misuse;
    }
    deepfauneEndpoint = await prompter.input({
      message: 'DeepFaune HTTP endpoint:',
      default: 'http://localhost:8002',
      validate: (v) => /^https?:\/\//.test(v) || 'expected http(s):// URL',
    });
  }

  // 5) Sink picks.
  const sinkPicks = await prompter.checkbox({
    message: 'Sink plugins to enable (you can change later):',
    choices: [
      {
        name: 'MQTT broker (Home Assistant, mosquitto, …)',
        value: SINK_MQTT,
        checked: true,
      },
      {
        name: 'Generic webhook (n8n, IFTTT, …)',
        value: SINK_WEBHOOK,
        checked: false,
      },
      {
        name: 'HTTP-multipart endpoint (legacy form / generic upstream)',
        value: SINK_HTTP_MULTIPART,
        checked: false,
      },
      {
        name: 'Local NDJSON audit log',
        value: SINK_FILE_NDJSON,
        checked: true,
      },
    ],
  });
  if (sinkPicks.length === 0) {
    io.err('init aborted — at least one sink must be enabled.\n');
    return ExitCode.Misuse;
  }

  const sinkAnswers = {
    mqttBrokerUrl: '',
    mqttTopicPattern: '',
    webhookUrl: '',
    httpMultipartEndpoint: '',
    httpMultipartWireFormat: 'framescout-v1' as 'framescout-v1' | 'bulletin-v1',
    fileNdjsonPath: '',
  };
  if (sinkPicks.includes(SINK_MQTT)) {
    sinkAnswers.mqttBrokerUrl = await prompter.input({
      message: 'MQTT broker URL:',
      default: 'mqtt://homeassistant.local',
      validate: (v) => /^mqtts?:\/\//.test(v) || 'expected mqtt(s):// URL',
    });
    sinkAnswers.mqttTopicPattern = await prompter.input({
      message: 'MQTT topic pattern:',
      default: 'framescout/{deployment}/{camera}',
      validate: nonEmpty,
    });
  }
  if (sinkPicks.includes(SINK_WEBHOOK)) {
    sinkAnswers.webhookUrl = await prompter.input({
      message: 'Webhook URL (POST target):',
      default: 'http://localhost:5678/webhook/framescout',
      validate: (v) => /^https?:\/\//.test(v) || 'expected http(s):// URL',
    });
  }
  if (sinkPicks.includes(SINK_HTTP_MULTIPART)) {
    sinkAnswers.httpMultipartEndpoint = await prompter.input({
      message: 'HTTP-multipart endpoint URL:',
      default: 'http://localhost:3000/api/ingest',
      validate: (v) => /^https?:\/\//.test(v) || 'expected http(s):// URL',
    });
    sinkAnswers.httpMultipartWireFormat = await prompter.select<
      'framescout-v1' | 'bulletin-v1'
    >({
      message: 'Wire format:',
      choices: [
        { name: 'framescout-v1 (default)', value: 'framescout-v1' },
        { name: 'bulletin-v1 (legacy form)', value: 'bulletin-v1' },
      ],
      default: 'framescout-v1',
    });
  }
  if (sinkPicks.includes(SINK_FILE_NDJSON)) {
    sinkAnswers.fileNdjsonPath = await prompter.input({
      message: 'Local NDJSON audit-log directory:',
      default: '/var/lib/framescout/audit',
      validate: nonEmpty,
    });
  }

  // 6) Render YAML.
  const yamlText = renderConfig({
    deploymentId,
    cameraId,
    sourcePkg,
    hubBaseUrl,
    hubUsername,
    channel: Number.parseInt(channel, 10),
    pollIntervalMs: Number.parseInt(pollIntervalMs, 10),
    detectorPicks: detectorPicks.slice(),
    megadetectorEndpoint,
    deepfauneEndpoint,
    sinkPicks: sinkPicks.slice(),
    sinkAnswers,
  });

  // 7) Atomic write.
  const tmpPath = `${targetPath}.tmp`;
  await writeFile(tmpPath, yamlText, { encoding: 'utf-8', mode: 0o644 });
  await rename(tmpPath, targetPath);

  // 8) `.env.example` companion (idempotent — only append the keys
  // not already there). Lands next to the config file so a single
  // `cp config.yaml.example .env.example` workflow keeps them paired.
  const envKeys = buildEnvKeys({ detectorPicks: detectorPicks.slice(), sinkPicks: sinkPicks.slice() });
  await mergeEnvExample(envKeys, dirname(targetPath));

  io.out(`\nWrote ${targetPath}\n\n`);
  io.out('Environment variables this config references (set them before running):\n');
  for (const k of envKeys) io.out(`  ${k}\n`);
  io.out('\nNext steps:\n');
  io.out(`  framescout config validate ${opts.path}\n`);
  io.out('  framescout test sinks         # smoke-test every configured sink\n');
  io.out('  framescout test pipeline      # end-to-end synthetic-clip run\n');

  return ExitCode.Success;
}

function nonEmpty(v: string): true | string {
  return v.trim().length > 0 ? true : 'value required';
}

interface RenderInput {
  readonly deploymentId: string;
  readonly cameraId: string;
  readonly sourcePkg: string;
  readonly hubBaseUrl: string;
  readonly hubUsername: string;
  readonly channel: number;
  readonly pollIntervalMs: number;
  readonly detectorPicks: readonly string[];
  readonly megadetectorEndpoint: string;
  readonly deepfauneEndpoint: string;
  readonly sinkPicks: readonly string[];
  readonly sinkAnswers: {
    readonly mqttBrokerUrl: string;
    readonly mqttTopicPattern: string;
    readonly webhookUrl: string;
    readonly httpMultipartEndpoint: string;
    readonly httpMultipartWireFormat: 'framescout-v1' | 'bulletin-v1';
    readonly fileNdjsonPath: string;
  };
}

function renderConfig(input: RenderInput): string {
  const doc = new Document({
    framescout: {
      dataDir: '/var/lib/framescout',
      metricsPort: 9090,
    },
    deployments: [
      {
        id: input.deploymentId,
        cameras: [{ id: input.cameraId }],
      },
    ],
    sources: [
      {
        id: 'reolink-1',
        package: input.sourcePkg,
        config: {
          baseUrl: input.hubBaseUrl,
          username: input.hubUsername,
          passwordEnv: 'REOLINK_PASSWORD',
          channels: [
            {
              channel: input.channel,
              deploymentId: input.deploymentId,
              cameraId: input.cameraId,
            },
          ],
          pollIntervalMs: input.pollIntervalMs,
        },
      },
    ],
    detectors: input.detectorPicks.map((pkg) => {
      if (pkg === DETECTOR_MEGADETECTOR) {
        return {
          id: 'megadetector',
          package: DETECTOR_MEGADETECTOR,
          config: {
            endpoint: input.megadetectorEndpoint,
            apiKeyEnv: 'MEGADETECTOR_API_KEY',
            minConfidence: 0.4,
            skipFramesWithPersonAbove: 0.15,
          },
        };
      }
      return {
        id: 'deepfaune',
        package: DETECTOR_DEEPFAUNE,
        config: {
          endpoint: input.deepfauneEndpoint,
          apiKeyEnv: 'DEEPFAUNE_API_KEY',
          minConfidence: 0.4,
        },
      };
    }),
    sinks: input.sinkPicks.map((pkg) => {
      if (pkg === SINK_MQTT) {
        return {
          id: 'mqtt-ha',
          package: SINK_MQTT,
          config: {
            brokerUrl: input.sinkAnswers.mqttBrokerUrl,
            topicPattern: input.sinkAnswers.mqttTopicPattern,
            usernameEnv: 'MQTT_USERNAME',
            passwordEnv: 'MQTT_PASSWORD',
          },
        };
      }
      if (pkg === SINK_WEBHOOK) {
        return {
          id: 'webhook',
          package: SINK_WEBHOOK,
          config: {
            url: input.sinkAnswers.webhookUrl,
            bearerEnv: 'WEBHOOK_BEARER',
          },
        };
      }
      if (pkg === SINK_HTTP_MULTIPART) {
        return {
          id: 'http-multipart',
          package: SINK_HTTP_MULTIPART,
          config: {
            endpoint: input.sinkAnswers.httpMultipartEndpoint,
            wireFormat: input.sinkAnswers.httpMultipartWireFormat,
            bearerEnv: 'HTTP_MULTIPART_BEARER',
          },
        };
      }
      return {
        id: 'audit-log',
        package: SINK_FILE_NDJSON,
        config: {
          path: input.sinkAnswers.fileNdjsonPath,
          rotateLines: 1000,
        },
      };
    }),
  });

  // Emit a banner comment so the operator knows where the file came from.
  doc.commentBefore =
    ' Generated by `framescout init`.\n' +
    ' Secrets are referenced by environment-variable name (the `*Env` keys);\n' +
    ' export them before starting the daemon — see the .env.example next to this file or\n' +
    ' docs/configuration-reference.md for the full key list.';

  return doc.toString({ lineWidth: 0, indent: 2 });
}

function buildEnvKeys(args: {
  readonly detectorPicks: readonly string[];
  readonly sinkPicks: readonly string[];
}): readonly string[] {
  const keys: string[] = ['REOLINK_PASSWORD'];
  if (args.detectorPicks.includes(DETECTOR_MEGADETECTOR)) keys.push('MEGADETECTOR_API_KEY');
  if (args.detectorPicks.includes(DETECTOR_DEEPFAUNE)) keys.push('DEEPFAUNE_API_KEY');
  if (args.sinkPicks.includes(SINK_MQTT)) keys.push('MQTT_USERNAME', 'MQTT_PASSWORD');
  if (args.sinkPicks.includes(SINK_WEBHOOK)) keys.push('WEBHOOK_BEARER');
  if (args.sinkPicks.includes(SINK_HTTP_MULTIPART)) keys.push('HTTP_MULTIPART_BEARER');
  return keys;
}

async function mergeEnvExample(
  keys: readonly string[],
  dir: string,
): Promise<void> {
  const path = resolve(dir, '.env.example');
  let existing = '';
  try {
    const s = await stat(path);
    if (s.isFile()) {
      const { readFile } = await import('node:fs/promises');
      existing = await readFile(path, 'utf-8');
    }
  } catch {
    // file doesn't exist — start fresh
  }
  const hasKey = (k: string): boolean => new RegExp(`(^|\\n)${k}=`).test(existing);
  const missing = keys.filter((k) => !hasKey(k));
  if (missing.length === 0) return;
  const banner = existing.endsWith('\n') || existing === '' ? '' : '\n';
  const block =
    `${banner}# Added by framescout init at ${new Date().toISOString()}\n` +
    missing.map((k) => `${k}=`).join('\n') +
    '\n';
  await writeFile(path, existing + block, 'utf-8');
}
