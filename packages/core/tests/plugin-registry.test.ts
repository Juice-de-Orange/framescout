import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PluginRegistry } from '../src/plugin-registry.js';

const aSchema = z.object({ a: z.string() });
const bSchema = z.object({ b: z.number() });

describe('PluginRegistry', () => {
  it('stores and looks up plugins by instanceId', () => {
    const r = new PluginRegistry();
    r.register({
      instanceId: 'sink-1',
      kind: 'sink',
      packageName: '@framescout/sink-foo',
      configSchema: aSchema,
    });
    expect(r.byInstanceId('sink-1')?.packageName).toBe('@framescout/sink-foo');
    expect(r.byInstanceId('nope')).toBeUndefined();
  });

  it('all() returns every registered plugin', () => {
    const r = new PluginRegistry();
    r.register({
      instanceId: 'a',
      kind: 'source',
      packageName: 'src',
      configSchema: aSchema,
    });
    r.register({
      instanceId: 'b',
      kind: 'detector',
      packageName: 'det',
      configSchema: bSchema,
    });
    expect(r.all()).toHaveLength(2);
  });

  it('byKind() filters by plugin kind', () => {
    const r = new PluginRegistry();
    r.register({ instanceId: 's', kind: 'source', packageName: 'p', configSchema: aSchema });
    r.register({ instanceId: 'd', kind: 'detector', packageName: 'p', configSchema: aSchema });
    r.register({ instanceId: 'k1', kind: 'sink', packageName: 'p', configSchema: aSchema });
    r.register({ instanceId: 'k2', kind: 'sink', packageName: 'p', configSchema: aSchema });
    expect(r.byKind('sink').map((p) => p.instanceId).sort()).toEqual(['k1', 'k2']);
  });

  it('re-registering an instanceId overwrites the previous entry', () => {
    const r = new PluginRegistry();
    r.register({ instanceId: 'a', kind: 'source', packageName: 'old', configSchema: aSchema });
    r.register({ instanceId: 'a', kind: 'source', packageName: 'new', configSchema: aSchema });
    expect(r.byInstanceId('a')?.packageName).toBe('new');
    expect(r.all()).toHaveLength(1);
  });

  it('clear() drops everything', () => {
    const r = new PluginRegistry();
    r.register({ instanceId: 'a', kind: 'source', packageName: 'p', configSchema: aSchema });
    r.clear();
    expect(r.all()).toEqual([]);
  });
});
