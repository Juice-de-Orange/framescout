import { framescoutConfigSchema } from '@framescout/core';
import { zodToJsonSchema, type Options as ZodToJsonOptions } from 'zod-to-json-schema';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';

export interface ConfigSchemaOptions {
  json?: boolean;
}

export function cmdConfigSchema(_opts: ConfigSchemaOptions, io: CliIO): number {
  // The deeply-nested framescoutConfigSchema explodes TS's type inference when
  // passed to zodToJsonSchema (TS2589 "instantiation excessively deep").
  // Cast to `unknown` first to break the type-resolution chain — runtime is
  // unaffected, and zod-to-json-schema only inspects the value at runtime.
  const options: Partial<ZodToJsonOptions> = { name: 'FramescoutConfig', $refStrategy: 'none' };
  const schema = zodToJsonSchema(framescoutConfigSchema as unknown as never, options);
  io.out(`${JSON.stringify(schema, null, 2)}\n`);
  return ExitCode.Success;
}
