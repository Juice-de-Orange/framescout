// Programmatic entry — tests import buildCli/runCli; production users
// run the `framescout` bin (see src/main.ts).
export { buildCli, runCli } from './cli.js';
export { defaultIO, type CliIO } from './io.js';
export { ExitCode } from './exit-codes.js';
