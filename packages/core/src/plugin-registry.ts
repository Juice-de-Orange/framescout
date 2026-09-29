import type { ZodTypeAny } from 'zod';

export type PluginKind = 'source' | 'detector' | 'sink';

export interface RegisteredPlugin {
  /** Instance id from `config.yaml` (e.g., `'mqtt-ha'`, `'megadetector'`). */
  readonly instanceId: string;
  /** Plugin kind from the package manifest. */
  readonly kind: PluginKind;
  /** npm package name (e.g., `'@framescout/sink-mqtt'`). */
  readonly packageName: string;
  /** Manifest-declared displayName, if any. */
  readonly displayName?: string;
  /** The plugin's Zod config schema — used to render JSON Schema for the UI. */
  readonly configSchema: ZodTypeAny;
}

/**
 * Central registry the daemon populates after wiring plugins. The
 * Operator UI reads it through `/api/plugins/schemas` to build its
 * Configuration form (FOUNDATION.md §4); the rest of the host treats
 * it as observability surface.
 *
 * The plugin loader is the natural owner: every successful
 * `loadPlugin` call should hand the resulting (manifest, schema)
 * pair here.
 */
export class PluginRegistry {
  private readonly items = new Map<string, RegisteredPlugin>();

  register(plugin: RegisteredPlugin): void {
    this.items.set(plugin.instanceId, plugin);
  }

  byInstanceId(id: string): RegisteredPlugin | undefined {
    return this.items.get(id);
  }

  all(): readonly RegisteredPlugin[] {
    return [...this.items.values()];
  }

  byKind(kind: PluginKind): readonly RegisteredPlugin[] {
    return this.all().filter((p) => p.kind === kind);
  }

  clear(): void {
    this.items.clear();
  }
}
