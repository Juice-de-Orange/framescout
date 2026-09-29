// Typed errors emitted by the plugin loader. Each carries the package
// specifier so upstream observability can attribute failures to a
// specific plugin without parsing messages.

export class PluginLoadError extends Error {
  override readonly name: string = 'PluginLoadError';

  constructor(
    message: string,
    readonly packageName: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export class MissingManifest extends PluginLoadError {
  override readonly name: string = 'MissingManifest';

  constructor(packageName: string) {
    super(
      `Package "${packageName}" has no "framescout" field in its package.json. ` +
        'Framescout plugins must declare a manifest; see docs/ARCHITECTURE.md §5.4.',
      packageName,
    );
  }
}

export class IncompatibleApiVersion extends PluginLoadError {
  override readonly name: string = 'IncompatibleApiVersion';

  constructor(
    packageName: string,
    readonly required: string,
    readonly actual: string,
  ) {
    super(
      `Plugin "${packageName}" requires plugin-api "${required}", but this runtime ` +
        `provides "${actual}". Upgrade the plugin or the runtime.`,
      packageName,
    );
  }
}

export class MissingFactoryExport extends PluginLoadError {
  override readonly name: string = 'MissingFactoryExport';

  constructor(packageName: string) {
    super(
      `Plugin "${packageName}" does not export a factory. ` +
        'Expected either a default export or a named "factory" export.',
      packageName,
    );
  }
}

export class ManifestMismatch extends PluginLoadError {
  override readonly name: string = 'ManifestMismatch';

  constructor(
    packageName: string,
    readonly packageId: string,
    readonly factoryId: string,
  ) {
    super(
      `Plugin "${packageName}" manifest mismatch: package.json declares id ` +
        `"${packageId}" but the factory's manifest claims "${factoryId}".`,
      packageName,
    );
  }
}

export class ConfigValidationError extends PluginLoadError {
  override readonly name: string = 'ConfigValidationError';

  constructor(
    packageName: string,
    readonly issues: unknown,
    cause: unknown,
  ) {
    super(
      `Plugin "${packageName}" config did not pass validation. See cause for details.`,
      packageName,
      { cause },
    );
  }
}

export class InitTimeout extends PluginLoadError {
  override readonly name: string = 'InitTimeout';

  constructor(
    packageName: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Plugin "${packageName}" init() did not complete within ${timeoutMs} ms.`,
      packageName,
    );
  }
}

export class InitFailed extends PluginLoadError {
  override readonly name: string = 'InitFailed';

  constructor(packageName: string, cause: unknown) {
    super(`Plugin "${packageName}" init() threw an error.`, packageName, { cause });
  }
}
