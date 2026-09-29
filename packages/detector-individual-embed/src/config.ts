import { z } from 'zod';

/**
 * Backbone configuration — discriminated union over a registry-known
 * short-name (`dinov2-small`) and a fully-custom ONNX path with
 * declared input/output shape.
 *
 * Why a union: the registry is shared with `framescout models` CLI
 * and handles auto-fetch + checksum verify. Custom paths skip the
 * registry — useful for non-commercial deployments swapping in
 * MegaDescriptor, or for fine-tuned models the operator trains
 * later.
 */
const knownBackboneSchema = z.object({
  kind: z.enum(['dinov2-small']),
});

const customBackboneSchema = z.object({
  kind: z.literal('custom'),
  /** Absolute or daemon-cwd-relative path to the .onnx file. */
  onnxPath: z.string().min(1),
  /** Square crop size (pixels) fed to the model. */
  inputSize: z.number().int().positive(),
  /** Embedding length the model produces. */
  outputDim: z.number().int().positive(),
  /** Whether to L2-normalise the embedding before cosine-sim. */
  normalize: z.enum(['l2', 'none']).default('l2'),
});

export const backboneConfigSchema = z.discriminatedUnion('kind', [
  knownBackboneSchema,
  customBackboneSchema,
]);

export type BackboneConfig = z.infer<typeof backboneConfigSchema>;

export const individualEmbedConfigSchema = z.object({
  backbone: backboneConfigSchema.default({ kind: 'dinov2-small' }),
  /**
   * Allow-list of upstream Detection labels this detector reacts to.
   * Refuse to start if empty — see INDIVIDUAL-RECOGNITION.md §10 Q5.
   */
  onlyForLabels: z.array(z.string().min(1)).min(1),
  /**
   * Global cosine-similarity threshold; per-individual `manifest.json`
   * may override. Below threshold → `unknown` (open-set behaviour).
   */
  similarityThreshold: z.number().min(0).max(1).default(0.75),
  /**
   * Required gap between the best and the runner-up cosine similarity
   * before an individual is tagged. Guards against confidently naming one
   * of two look-alikes; below the margin the result is `unknown`.
   * Mirrors INDIVIDUAL_MARGIN on the Python inference server, which had
   * this from the start while the TypeScript matcher did not.
   */
  individualMargin: z.number().min(0).max(1).default(0.05),
  /**
   * Where to read the per-individual centroid manifests. Default is
   * `<dataDir>/individuals/` resolved at construct-time by the daemon.
   */
  referenceDir: z.string().min(1).optional(),
  /** Cache centroids on disk; recompute on photo change. */
  cacheEmbeddings: z.boolean().default(true),
  /**
   * Extra padding around the detection bbox before crop+embed. 0.1 =
   * 10 % outward on each side. Helps the embedding see context that
   * a tight crop loses.
   */
  cropPadding: z.number().min(0).max(0.5).default(0.1),
  /** Per-frame embed timeout (ms). Default 5 s. */
  embedTimeoutMs: z.number().int().positive().default(5_000),
});

export type IndividualEmbedConfig = z.infer<typeof individualEmbedConfigSchema>;
