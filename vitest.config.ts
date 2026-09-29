import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    // No workspace-wide `dangerouslyIgnoreUnhandledErrors`: it would hide every
    // unhandled rejection in all tests. The one known case is suppressed
    // package-locally in packages/sink-http-multipart, with its rationale.
  },
});
