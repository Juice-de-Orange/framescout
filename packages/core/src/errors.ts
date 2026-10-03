// Typed errors emitted by the plugin loader. Each carries the package
// specifier so upstream observability can attribute failures to a
// specific plugin without parsing messages.

import { redactUrlCredentials } from './logger.js';

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

/**
 * One-line description of an error for plain-text output (CLI results,
 * the daemon's last `fatal:` line): the message followed by the message
 * of every `cause`. Wrapper errors such as {@link InitFailed} say *that*
 * something failed; the reason ("connect ECONNREFUSED …") sits in the
 * cause and is what the operator needs to see. URL credentials are masked.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const message =
      current instanceof Error
        ? current.message || current.name
        : typeof current === 'string'
          ? current
          : safeJson(current);
    // Sentence-style wrapper messages end in a period; drop it before the
    // next part is appended with ": ".
    const part = message.replace(/\.$/u, '');
    if (part !== '' && !parts.some((p) => p.includes(part))) parts.push(part);
    current = current instanceof Error ? current.cause : undefined;
  }
  return redactUrlCredentials(parts.join(': '));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
