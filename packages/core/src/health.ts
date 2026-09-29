// Back-compat shim — the operator HTTP surface moved to `http/server.ts`
// in v0.1.1 to make room for the v0.2 Operator UI on the same port
// (FOUNDATION.md ADR-01 + §C.1). The original `startHealthServer`
// signature is preserved by aliasing into the new function.

export {
  startHttpServer as startHealthServer,
  type StartHttpServerOptions as StartHealthServerOptions,
  type HttpServerHandle as HealthServerHandle,
} from './http/server.js';
