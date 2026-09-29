# @framescout/plugin-api

Public plugin contracts for Framescout: the `Source`, `Detector`, and
`Sink` interfaces; the `PluginFactory` / `PluginLifecycle` / `PluginContext`
host-surface types; and shared data types (`CaptureEvent`, `Frame`,
`Detection`, `Observation`, `SinkPayload`).

The package is intentionally tiny — it defines **only types and the
`API_VERSION` constant**. There is no runtime behaviour. Plugins import
the types they need; the Framescout core implements the host side.

## Stability

`@framescout/plugin-api` versions independently of the daemon.

- **`0.x`** is **unstable**. Any release may be a breaking change.
  Plugins should declare a tight range — for v0.1.x, use
  `"@framescout/plugin-api": "^0.1.0"` in `peerDependencies`.
- The package **freezes at `1.0.0` once the daemon reaches `v1.0`**.
  After that, strict SemVer applies and breaking changes require a
  major bump.

See `docs/ROADMAP.md` for the wider versioning policy and
`docs/ARCHITECTURE.md` §5 for the canonical contract.

## Manifest

A Framescout plugin is an npm package whose `package.json` declares a
`framescout` field — read by the loader **before** any plugin code is
imported:

```json
{
  "name": "@your-scope/framescout-plugin-foo",
  "type": "module",
  "main": "./dist/index.js",
  "framescout": {
    "apiVersion": "^0.1.0",
    "kind": "source",
    "id": "your-id",
    "displayName": "Human-Facing Label"
  },
  "peerDependencies": {
    "@framescout/plugin-api": "^0.1.0"
  }
}
```

If the manifest's `apiVersion` range does not satisfy the runtime's
`API_VERSION`, the loader fails fast with a clear error before
importing the plugin module.

## License

Apache-2.0. See the repository root `LICENSE` file.
