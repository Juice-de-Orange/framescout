/**
 * Minimal IO abstraction so commands stay testable. Production builds
 * pass `process.stdout` / `process.stderr`; tests pass an in-memory
 * collector and inspect the buffered output.
 */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export const defaultIO: CliIO = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};
