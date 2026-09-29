/**
 * CLI exit codes per V0.1-SCOPE §5. Scripts pipelined into framescout
 * can branch on the exact failure mode without parsing stderr.
 */
export const ExitCode = {
  Success: 0,
  GenericFailure: 1,
  Misuse: 2,
  ConfigValidation: 3,
  PluginLoad: 4,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
