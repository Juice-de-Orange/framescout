import { describe, expect, it } from 'vitest';

import * as core from '../src/index.js';

describe('@framescout/core public surface', () => {
  it('exports loadPlugin and createPluginContext', () => {
    expect(typeof core.loadPlugin).toBe('function');
    expect(typeof core.createPluginContext).toBe('function');
    expect(typeof core.createRootLogger).toBe('function');
  });

  it('exports the typed plugin-loader errors', () => {
    expect(core.PluginLoadError).toBeDefined();
    expect(core.MissingManifest).toBeDefined();
    expect(core.IncompatibleApiVersion).toBeDefined();
    expect(core.MissingFactoryExport).toBeDefined();
    expect(core.ManifestMismatch).toBeDefined();
    expect(core.ConfigValidationError).toBeDefined();
    expect(core.InitTimeout).toBeDefined();
    expect(core.InitFailed).toBeDefined();
  });
});
