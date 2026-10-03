// @framescout/core — host runtime: plugin loader + observability primitives +
// pipeline composition. See docs/ARCHITECTURE.md §5 (plugin API), §6 (pipeline),
// §9 (observability). Phase 4a adds the pipeline orchestrator,
// BoundedSinkWrapper, and CircuitBreaker; Phase 4b replaces the decode/score
// stubs with ffmpeg + Tenengrad.

export {
  loadPlugin,
  type LoadPluginOptions,
  type LoadedPlugin,
} from './loader.js';
export {
  createPluginContext,
  type CreatePluginContextOptions,
} from './context.js';
export {
  createRootLogger,
  redactUrlCredentials,
  type CreateRootLoggerOptions,
  type LogLevel,
} from './logger.js';
export {
  createMetricsRegistry,
  ManualReadyState,
  type CreateMetricsRegistryOptions,
  type FramescoutMetrics,
  type FramescoutRegistry,
  type MetricRouter,
  type ReadyState,
} from './metrics.js';
export {
  startHealthServer,
  type HealthServerHandle,
  type StartHealthServerOptions,
} from './health.js';
export {
  startHttpServer,
  type HttpServerHandle,
  type StartHttpServerOptions,
} from './http/server.js';
export { Router, type RouteHandler, type RouteMatch } from './http/router.js';
export {
  ObservationRing,
  type ObservationRingEntry,
  type ObservationSubscriber,
} from './observation-ring.js';
export {
  LogRing,
  type LogRingEntry,
  type LogSubscriber,
} from './log-ring.js';
export {
  PluginRegistry,
  type PluginKind,
  type RegisteredPlugin,
} from './plugin-registry.js';
export {
  StateProvider,
  type DetectorState,
  type SourceState,
  type StateSnapshot,
  type StateProviderOptions,
  type StateSubscriber,
} from './state-snapshot.js';
export type { SinkInfo, SinkInfoListener } from './sink/bounded-sink.js';
export {
  synthesizeEvent,
  synthesizeFrame,
  synthesizeSinkPayload,
} from './sink-test.js';
export {
  fileTokenStore,
  type TokenFile,
} from './auth/token-file.js';
export {
  inMemorySessionStore,
  type InMemorySessionStoreOptions,
  type SessionStore,
} from './auth/session.js';
export {
  buildLoginHandler,
  buildLogoutHandler,
  requireAuth,
  type AuthOptions,
} from './auth/middleware.js';
export {
  buildSetCookieHeader,
  clearCookieHeader,
  readCookie,
  SESSION_COOKIE_NAME,
} from './auth/cookies.js';
export {
  registerApiRoutes,
  type ApiRoutesDeps,
  type DaemonInfo,
} from './http/api-routes.js';
export { SseStream, type SseSendOptions, type SseStreamOptions } from './http/sse.js';
export {
  registerStaticAssets,
  type StaticAssetsOptions,
} from './http/static-assets.js';
export {
  applyPending,
  ConfigInvalidError,
  discardPending,
  listBackups,
  NoPendingError,
  PendingExistsError,
  pendingState,
  preserveEnvTagsRoundTrip,
  resolveConfigPaths,
  restoreBackup,
  stagePending,
  validateText,
  type ApplyResult,
  type BackupInfo,
  type ConfigPaths,
  type ConfigPathsResolved,
  type ValidateIssues,
  type ValidateOk,
  type ValidateResult,
} from './config-apply.js';
export {
  ConfigValidationError,
  IncompatibleApiVersion,
  InitFailed,
  InitTimeout,
  ManifestMismatch,
  MissingFactoryExport,
  MissingManifest,
  PluginLoadError,
} from './errors.js';

// ── Phase 4a: pipeline + bounded sink ───────────────────────────────
export {
  BoundedSinkWrapper,
  type BoundedSinkWrapperOptions,
  type OverflowPolicy,
} from './sink/bounded-sink.js';
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './sink/circuit-breaker.js';
export {
  runPipeline,
  type DecodeStage,
  type PipelineDetector,
  type PipelineSource,
  type RunPipelineOptions,
  type ScoreStage,
} from './pipeline/run.js';
export {
  buildObservation,
  pickBestFrame,
  pickPrimaryDetection,
  type BuildObservationOptions,
} from './pipeline/observation.js';
export { mergeAsyncIterables } from './pipeline/merge.js';
export { decodeStub, scoreStub } from './pipeline/stages-stub.js';
export {
  decodeClip,
  type DecodeClipOptions,
} from './pipeline/decode.js';
export {
  scoreFrames,
  tenengrad,
  motionFraction,
  compositeScore,
  type ScoreFramesOptions,
} from './pipeline/score.js';
export {
  adaptiveCropBox,
  type AdaptiveCropInput,
  type CropBox,
} from './pipeline/adaptive-crop.js';
export {
  applyCropForObservation,
  type ImageOutputOptions,
} from './pipeline/apply-crop.js';

// ── Phase 12: config.yaml shape + loader ────────────────────────────
export {
  framescoutConfigSchema,
  loadConfig,
  parseConfigText,
  type DetectorEntry,
  type FramescoutConfig,
  type SinkEntry,
  type SourceEntry,
} from './config.js';

// ── v0.2.x: backbone weight registry (individual recognition) ──────
export {
  KNOWN_BACKBONES,
  knownBackboneNames,
  lookupBackbone,
  type BackboneEntry,
} from './models/registry.js';
export {
  fetchModel,
  verifyModels,
  BackboneNotPinnedError,
  UnknownBackboneError,
  ChecksumMismatchError,
  type FetchModelOptions,
  type FetchModelResult,
  type VerifyEntry,
} from './models/fetch.js';
export {
  createIndividualsService,
  IndividualNotFoundError,
  IndividualExistsError,
  NoPhotosError,
  type EmbedFn,
  type IndividualSummary,
  type IndividualsService,
  type CreateIndividualsServiceOptions,
} from './individuals/service.js';
export {
  createDatasetService,
  DatasetObservationNotFoundError,
  InvalidLabelError,
  type DatasetService,
  type DatasetSample,
  type DatasetStats,
  type CreateDatasetServiceOptions,
} from './dataset/service.js';
export {
  createLabelQueueService,
  QueueItemNotFoundError,
  type LabelQueueService,
  type QueueItem,
  type QueueStats,
  type EnqueueInput,
  type CreateLabelQueueServiceOptions,
} from './labelqueue/service.js';
