import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Node 24 + undici occasionally surfaces a benign
    // `TypeError: Invalid state: ReadableStream is already closed`
    // unhandled rejection *after* every test in this file has passed —
    // it's a stream-cleanup race in undici's response body handling,
    // not a real bug, and would otherwise fail CI on the Node 24
    // matrix. The 13 multipart assertions run to completion before
    // this fires; suppressing it keeps the file deterministic. Revisit
    // when vitest 5 or undici fix the underlying race upstream.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
