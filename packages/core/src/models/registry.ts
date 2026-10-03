/**
 * Known short-name backbones for the individual-recognition detector
 * (and any future embedding-based plugin). Each entry pins a URL +
 * SHA256 so we can verify the on-disk file before handing it to the
 * ONNX runtime.
 *
 * Adding a new short-name backbone is a two-line PR: add the entry
 * here, document it in `docs/INDIVIDUAL-RECOGNITION.md` §3.2.
 *
 * Callers that want to use a custom (non-registry) model use the
 * `backbone.kind: 'custom'` discriminated-union variant on the
 * detector config and bypass this registry entirely.
 */
export interface BackboneEntry {
  /** Fully qualified URL that serves the .onnx file. */
  readonly url: string;
  /** Lower-case hex SHA-256 of the .onnx file at `url`. */
  readonly sha256: string;
  /** Expected file size in bytes — a quick sanity-check before SHA. */
  readonly sizeBytes: number;
  /** Square crop size (pixels) fed to the model. */
  readonly inputSize: number;
  /** Embedding length the model produces. */
  readonly outputDim: number;
  /** Whether the embedding should be L2-normalised before cosine-sim. */
  readonly normalize: 'l2' | 'none';
  /**
   * Number of species classes the model's classification head emits.
   * Present only for classifier backbones (e.g. a fine-tuned
   * `framescout-classifier-*`); absent for pure embedding backbones
   * like `dinov2-small`.
   */
  readonly numClasses?: number;
  /**
   * URL serving the `labels.json` (index → species label) the classifier
   * was trained with. Present only for classifier backbones; pinned the
   * same way as the weights. The inference server reads this to map
   * logits back to class names.
   */
  readonly labelsUrl?: string;
}

/**
 * Pinned registry of known backbones. Entries are immutable — the
 * SHA256 binds the URL content; a backbone-update is a new short-name
 * (e.g. `dinov2-small-v2`), not a mutation.
 *
 * `dinov2-small` weights are released by Meta under Apache-2.0; the
 * ONNX export comes from the HuggingFace `onnx-community` mirror.
 * An entry whose SHA is still the placeholder is rejected by
 * `fetchModel()` with `BackboneNotPinnedError`.
 */
export const KNOWN_BACKBONES: Readonly<Record<string, BackboneEntry>> = {
  'dinov2-small': {
    // HuggingFace onnx-community export of facebook/dinov2-small. The
    // URL names a commit, not `main`: a moving ref would break the
    // checksum the day the mirror re-exports the model.
    url: 'https://huggingface.co/onnx-community/dinov2-small/resolve/8b1f705a3a7f6f062f6bdd21986c1583d3ef105d/onnx/model.onnx',
    sha256: 'f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a',
    sizeBytes: 88_532_934,
    inputSize: 224,
    outputDim: 384,
    normalize: 'l2',
  },

  // Your own fine-tuned species + embedding classifier. Two ONNX
  // outputs: `embedding` (outputDim floats, L2-normalised) for
  // per-individual centroid matching, and `logits` (numClasses) for
  // species. Trained offline (see `training/`) on your labelled
  // images, exported by `training/framescout_trainer/export_onnx.py`,
  // and served by `services/inference-server/`.
  //
  // The URL + SHA + labels are pinned by the maintainer after training:
  //   1. host model.onnx + labels.json somewhere fetchable (GitHub
  //      release asset, internal HTTP, or a volume on the inference host),
  //   2. set the url/labelsUrl below,
  //   3. `framescout models fetch framescout-classifier-v1 --pin`
  //      prints the SHA — commit it here.
  // Until pinned, `fetchModel` fails closed (BackboneNotPinnedError).
  // The daemon host never fetches this — only the inference server does
  // (or rsync the file to a volume on the inference host).
  //
  // outputDim 768 = convnextv2_tiny feature width (the recommended
  // backbone, see docs/SPECIES-CLASSIFIER.md). numClasses is a
  // placeholder until the maintainer's label set is finalised.
  'framescout-classifier-v1': {
    url: 'https://github.com/Juice-de-Orange/framescout/releases/download/classifier-v1/model.onnx',
    labelsUrl:
      'https://github.com/Juice-de-Orange/framescout/releases/download/classifier-v1/labels.json',
    sha256: 'PINNED-PENDING-VERIFICATION',
    sizeBytes: 120_000_000,
    inputSize: 224,
    outputDim: 768,
    normalize: 'l2',
    numClasses: 8,
  },
};

/** Names of every backbone the registry knows. */
export function knownBackboneNames(): readonly string[] {
  return Object.keys(KNOWN_BACKBONES);
}

/**
 * Look up a backbone by short-name. Returns `undefined` for unknown
 * names so the caller can decide whether to fall through to a
 * `kind: 'custom'` config path or surface an error.
 */
export function lookupBackbone(name: string): BackboneEntry | undefined {
  return KNOWN_BACKBONES[name];
}
