import type { ZodError } from 'zod';

// Unknown keys in the core config are a validation error (every core
// object is `.strict()`), but Zod only says "Unrecognized key(s) in
// object: 'bnd'". `withKeyHints` adds the closest key the schema knows at
// that place — "(did you mean 'bind'?)". Plugin `config` blocks are
// validated by the plugin's own (usually non-strict) schema, which drops
// unknown keys without a word; `findUnknownKeys` lets the loader warn
// about them.
//
// Schemas are inspected through Zod 3's `_def.typeName`, not `instanceof`:
// a plugin may bring its own copy of zod. A schema this code does not
// understand simply yields no hints.

interface SchemaLike {
  readonly _def?: {
    readonly typeName?: string;
    readonly innerType?: SchemaLike;
    readonly schema?: SchemaLike;
    readonly getter?: () => SchemaLike;
    readonly options?: ReadonlyArray<SchemaLike> | ReadonlyMap<unknown, SchemaLike>;
    readonly type?: SchemaLike;
    readonly valueType?: SchemaLike;
    readonly shape?: () => Record<string, SchemaLike>;
    readonly unknownKeys?: string;
    readonly catchall?: SchemaLike;
  };
}

/** Strip wrappers that do not change an object's keys; split unions. */
function expand(schema: SchemaLike | undefined): SchemaLike[] {
  const def = schema?._def;
  if (!schema || !def) return [];
  switch (def.typeName) {
    case 'ZodDefault':
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
    case 'ZodCatch':
      return expand(def.innerType);
    case 'ZodEffects':
      return expand(def.schema);
    case 'ZodLazy':
      return def.getter ? expand(def.getter()) : [];
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options;
      if (!options) return [];
      return [...(options instanceof Map ? options.values() : options)].flatMap(expand);
    }
    default:
      return [schema];
  }
}

function shapeOf(schema: SchemaLike): Record<string, SchemaLike> | undefined {
  const def = schema._def;
  return def?.typeName === 'ZodObject' && def.shape ? def.shape() : undefined;
}

function acceptsExtraKeys(schema: SchemaLike): boolean {
  const catchall = schema._def?.catchall?._def?.typeName;
  return catchall !== undefined && catchall !== 'ZodNever';
}

/**
 * The keys the schema accepts for the object at `path`, or undefined when
 * the schema has no object there (or accepts any key, like a record).
 */
export function knownKeysAt(
  schema: unknown,
  path: ReadonlyArray<string | number>,
): string[] | undefined {
  let nodes = expand(schema as SchemaLike);
  for (const segment of path) {
    const next: SchemaLike[] = [];
    for (const node of nodes) {
      const shape = shapeOf(node);
      const def = node._def;
      if (shape && typeof segment === 'string') {
        next.push(...expand(shape[segment]));
      } else if (def?.typeName === 'ZodArray' && typeof segment === 'number') {
        next.push(...expand(def.type));
      } else if (def?.typeName === 'ZodRecord') {
        next.push(...expand(def.valueType));
      }
    }
    nodes = next;
  }
  const shapes = nodes.map(shapeOf);
  if (shapes.length === 0 || shapes.some((s) => s === undefined)) return undefined;
  // `.passthrough()` / `.catchall()` objects accept every key on purpose.
  if (nodes.some((n) => n._def?.unknownKeys === 'passthrough' || acceptsExtraKeys(n))) {
    return undefined;
  }
  return [...new Set(shapes.flatMap((s) => Object.keys(s!)))];
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(
        above + 1,
        row[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * The known key closest to `key`, or undefined when none is close: case
 * differences count as nothing, and at most a third of the longer name may
 * differ (so names of one or two characters never get a guess).
 */
export function closestKey(key: string, known: ReadonlyArray<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  if (best === undefined) return undefined;
  const allowed = Math.floor(Math.max(key.length, best.length) / 3);
  return bestDistance <= allowed ? best : undefined;
}

/**
 * Rewrite the message of every `unrecognized_keys` issue in `error` to name
 * the closest known key, in place (ZodError.message is built from the
 * issues, so every consumer sees the hint). Returns the same error.
 */
export function withKeyHints(error: ZodError, schema: unknown): ZodError {
  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    const known = knownKeysAt(schema, issue.path) ?? [];
    const parts = issue.keys.map((key) => {
      const hint = closestKey(key, known);
      return hint ? `'${key}' (did you mean '${hint}'?)` : `'${key}'`;
    });
    issue.message = `Unrecognized key(s) in object: ${parts.join(', ')}`;
  }
  return error;
}

export interface UnknownKey {
  /** Dotted path of the unknown key, e.g. `overflow.queuesize`. */
  readonly path: string;
  /** The closest known key at the same place, if one is close. */
  readonly didYouMean?: string;
}

/**
 * Keys in `value` that `schema` does not know — the ones a non-strict
 * object schema drops silently. Walks nested objects and arrays.
 */
export function findUnknownKeys(
  schema: unknown,
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): UnknownKey[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findUnknownKeys(schema, item, [...path, i]));
  }
  if (value === null || typeof value !== 'object') return [];
  const known = knownKeysAt(schema, path);
  const out: UnknownKey[] = [];
  for (const [key, child] of Object.entries(value)) {
    // `known === undefined`: any key is fine here (a record, a passthrough
    // object, or no object schema at all), but a record's values may still
    // be objects with a fixed shape.
    if (known === undefined || known.includes(key)) {
      out.push(...findUnknownKeys(schema, child, [...path, key]));
    } else {
      const hint = closestKey(key, known);
      out.push({
        path: [...path, key].join('.'),
        ...(hint === undefined ? {} : { didYouMean: hint }),
      });
    }
  }
  return out;
}
