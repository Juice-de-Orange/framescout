import { stat } from 'node:fs/promises';

import { InferenceSession, Tensor } from 'onnxruntime-node';
import {
  KNOWN_BACKBONES,
  fetchModel,
  type BackboneEntry,
} from '@framescout/core';

import type { BackboneConfig } from './config.js';

/**
 * Resolved backbone — runtime view of the user's config, with the
 * registry / custom indirection collapsed into a single struct that
 * the embed pipeline consumes.
 */
export interface ResolvedBackbone {
  readonly onnxPath: string;
  readonly inputSize: number;
  readonly outputDim: number;
  readonly normalize: 'l2' | 'none';
}

export interface LoadBackboneOptions {
  /** Daemon `<dataDir>` — used to compute `<dataDir>/models/<name>.onnx`. */
  readonly dataDir: string;
  /** Cancel an in-flight auto-fetch download. */
  readonly signal?: AbortSignal;
  readonly logger?: { info: (obj: object, msg: string) => void };
}

/**
 * Resolve the backbone config into an on-disk path + shape struct,
 * auto-fetching the weights when the config refers to a known
 * short-name and the file isn't cached yet.
 *
 * Refuses to download anything for custom backbones — those must
 * already exist on disk (the operator put them there).
 */
export async function resolveBackbone(
  cfg: BackboneConfig,
  opts: LoadBackboneOptions,
): Promise<ResolvedBackbone> {
  if (cfg.kind === 'custom') {
    await assertReadable(cfg.onnxPath);
    return {
      onnxPath: cfg.onnxPath,
      inputSize: cfg.inputSize,
      outputDim: cfg.outputDim,
      normalize: cfg.normalize,
    };
  }
  const entry: BackboneEntry | undefined = KNOWN_BACKBONES[cfg.kind];
  if (entry === undefined) {
    throw new Error(`unknown registry backbone ${cfg.kind}`);
  }
  const fetched = await fetchModel(cfg.kind, {
    dataDir: opts.dataDir,
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.logger !== undefined && { logger: opts.logger }),
  });
  return {
    onnxPath: fetched.path,
    inputSize: entry.inputSize,
    outputDim: entry.outputDim,
    normalize: entry.normalize,
  };
}

/**
 * Load + warm-up an ONNX session for the resolved backbone. Loading
 * is one-shot; the returned `Session` is reused for every embed call.
 *
 * Shape validation: after load we synthesise a dummy input with the
 * declared shape and run one inference. If the model produces a
 * tensor with a different output dim than the config declares, throw
 * — this catches mis-pinned custom backbones at load time, not at
 * the first real detection.
 */
export interface Session {
  readonly resolved: ResolvedBackbone;
  /** Names of the input + output tensors discovered at load time. */
  readonly inputName: string;
  readonly outputName: string;
  embed(rgbCHW: Float32Array): Promise<Float32Array>;
  close(): Promise<void>;
}

export async function loadSession(
  resolved: ResolvedBackbone,
): Promise<Session> {
  const session = await InferenceSession.create(resolved.onnxPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });

  if (session.inputNames.length !== 1) {
    throw new Error(
      `backbone has ${session.inputNames.length} inputs; expected exactly 1`,
    );
  }
  if (session.outputNames.length < 1) {
    throw new Error(
      `backbone has no outputs; expected at least 1 embedding tensor`,
    );
  }
  const inputName = session.inputNames[0]!;
  // Most vision-embedding ONNX exports name the embedding output
  // either "last_hidden_state" (DINOv2) or "embedding" / "features".
  // We take the first output; for DINOv2 we may also need to slice
  // the CLS token from a sequence output — handled in embed.ts.
  const outputName = session.outputNames[0]!;

  // Warm-up: black image, validates input shape + output dim match
  // the config declaration. Throws clear errors at load time so a
  // mis-declared custom backbone never makes it into production.
  const dummy = new Float32Array(3 * resolved.inputSize * resolved.inputSize);
  const dummyTensor = new Tensor('float32', dummy, [
    1,
    3,
    resolved.inputSize,
    resolved.inputSize,
  ]);
  const result = await session.run({ [inputName]: dummyTensor });
  const out = result[outputName];
  if (out === undefined) {
    throw new Error(`backbone output "${outputName}" missing from run result`);
  }
  const flat = out.data as Float32Array;
  // Two common output layouts:
  //   - [1, outputDim]                       (pooled embedding)
  //   - [1, seqLen, outputDim] / [1, outputDim, h*w] (sequence output;
  //     DINOv2's last_hidden_state has shape [B, 257, 384] for ViT-S)
  // Either way the last dim must equal the declared outputDim.
  const dims = out.dims;
  const lastDim = dims[dims.length - 1];
  if (lastDim !== resolved.outputDim) {
    await session.release();
    throw new Error(
      `backbone declared outputDim=${resolved.outputDim} but produced last-dim ${String(lastDim)} (full shape: ${JSON.stringify(dims)})`,
    );
  }
  void flat;

  return {
    resolved,
    inputName,
    outputName,
    async embed(rgbCHW: Float32Array): Promise<Float32Array> {
      const inputTensor = new Tensor('float32', rgbCHW, [
        1,
        3,
        resolved.inputSize,
        resolved.inputSize,
      ]);
      const r = await session.run({ [inputName]: inputTensor });
      const o = r[outputName];
      if (o === undefined) throw new Error('embed: output tensor missing');
      const flatOut = o.data as Float32Array;
      // For a sequence output (e.g. DINOv2 last_hidden_state with shape
      // [1, 257, 384]) the CLS token at index 0 is the standard
      // image-level embedding. Detect by rank: if rank > 2, take the
      // first `outputDim` floats.
      if (o.dims.length > 2) {
        return flatOut.slice(0, resolved.outputDim);
      }
      return flatOut;
    },
    async close(): Promise<void> {
      await session.release();
    },
  };
}

async function assertReadable(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      throw new Error(`backbone path ${path} is not a file`);
    }
  } catch (err) {
    throw new Error(
      `backbone path ${path} is not readable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
