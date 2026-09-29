// @framescout/plugin-api — public plugin contracts.
// See docs/ARCHITECTURE.md §5 for the canonical specification.

export { API_VERSION } from './plugin.js';
export type {
  PluginKind,
  PluginManifest,
  PluginContext,
  PluginFactory,
  PluginLifecycle,
  Logger,
  LogFn,
} from './plugin.js';
export type { CaptureEvent, Source } from './source.js';
export type { Frame } from './frame.js';
export type { Detection, DetectorInput, Detector } from './detection.js';
export type { Observation, SinkPayload, Sink } from './observation.js';
