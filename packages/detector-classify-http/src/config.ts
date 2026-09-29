import { z } from 'zod';

/**
 * Config for `@framescout/detector-classify-http`.
 *
 * This detector replaces `@framescout/detector-deepfaune-http` in the
 * chain: it runs *after* MegaDetector, takes each animal detection's
 * bbox, and POSTs the frame + bbox to a self-hosted classifier HTTP
 * service (see `services/inference-server/`). The service returns the
 * top species predictions and — when individual recognition is
 * enabled — an embedding the plugin matches against per-individual
 * centroids locally (no ONNX runtime on the daemon host).
 *
 * The `species` side mirrors `deepfaune-http`'s config 1:1 so the
 * bulletin-v1 wire format (`species`, `speciesDe`) is unchanged. The
 * optional `individuals` block mirrors `detector-individual-embed`'s
 * matcher knobs.
 */

const taxonRankSchema = z.union([
  z.literal('kingdom'),
  z.literal('phylum'),
  z.literal('class'),
  z.literal('order'),
  z.literal('family'),
  z.literal('genus'),
  z.literal('species'),
]);

const taxonomyEntrySchema = z.object({
  scientificName: z.string().min(1),
  taxonRank: taxonRankSchema,
  germanName: z.string().min(1).optional(),
});

/**
 * Individual-recognition knobs. Present → the detector loads centroids
 * from `referenceDir`, asks the server for an embedding per detection,
 * and tags `extra.individualName`. Absent → species-only (no embedding
 * request, no centroid I/O).
 */
const individualsConfigSchema = z.object({
  /** Global cosine-similarity threshold; per-individual manifest may override. */
  similarityThreshold: z.number().min(0).max(1).default(0.75),
  /**
   * Required gap between the best and the runner-up cosine similarity
   * before an individual is tagged. Guards against confidently naming one
   * of two look-alikes; below the margin the result is `unknown`.
   * Mirrors INDIVIDUAL_MARGIN on the Python inference server, which had
   * this from the start while the TypeScript matcher did not.
   */
  margin: z.number().min(0).max(1).default(0.05),
  /** Where centroid manifests live. Default `<dataDir>/individuals/`. */
  referenceDir: z.string().min(1).optional(),
  /**
   * Embedding length the classifier service returns. Centroids whose
   * `outputDim` differs are ignored at load (stale after a model swap;
   * run `framescout individuals recompute --all`).
   */
  embeddingDim: z.number().int().positive(),
  /** Whether to L2-normalise the embedding before cosine-sim. */
  normalize: z.enum(['l2', 'none']).default('l2'),
  /** Backbone short-name recorded in centroid manifests. */
  backboneName: z.string().min(1).default('framescout-classifier-v1'),
});

export const classifyHttpConfigSchema = z.object({
  endpoint: z.string().url('config.endpoint must be a valid URL'),
  apiKeyEnv: z.string().min(1).optional(),
  /** Model-version label embedded in every Detection. */
  modelVersion: z.string().min(1).default('v1'),
  /** Species predictions below this confidence are not used as the label. */
  minConfidence: z.number().min(0).max(1).default(0.4),
  /** Per-deployment taxonomy overrides/extensions, keyed by class label. */
  taxonomyOverrides: z.record(z.string(), taxonomyEntrySchema).default({}),
  /**
   * Allow-list of upstream Detection labels this detector classifies.
   * Default `['animal']` — MegaDetector's animal class. Refuse to start
   * if empty (mirrors individual-embed §10 Q5).
   */
  onlyForLabels: z.array(z.string().min(1)).min(1).default(['animal']),
  /** Outward padding fraction applied to the bbox before crop. */
  cropPadding: z.number().min(0).max(0.5).default(0.1),
  /** Per-request HTTP timeout (ms). Default 60 s (CPU inference). */
  timeoutMs: z.number().int().positive().default(60_000),
  individuals: individualsConfigSchema.optional(),
});

export type ClassifyHttpConfig = z.infer<typeof classifyHttpConfigSchema>;
export type IndividualsConfig = z.infer<typeof individualsConfigSchema>;
