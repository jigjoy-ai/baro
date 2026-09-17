# ADR-0004: Treat a symlinked node_modules as fresh in staleDependencyReasons

**Status:** Accepted
**Context:** With node_modules symlinked into __run, `existsSync` passes (verify.ts:528-532) but the mtime comparison against node_modules/.package-lock.json (verify.ts:541-558) can still report staleness, which would trigger the very `npm install` the linking is meant to avoid.
**Decision:** In packages/baro-orchestrator/src/verification/verify.ts, inside `staleDependencyReasons(cwd)` (verify.ts:515-560): after the existence check, if `lstatSync(join(cwd, "node_modules")).isSymbolicLink()` and `realpathSync(join(cwd, "node_modules"))` is not under `cwd`, return `[]` immediately (skip the unlinked-workspace and mtime checks). Leave dependencyRefreshCommand (verify.ts:566-583), dependencyRefreshEnabled (verify.ts:585-588) and detectPackageManager (verify.ts:232-247) unchanged.
**Consequences:** Freshness of a linked tree is owned entirely by the materializer. A host with stale node_modules propagates that staleness into __run; that is the intended trade for incrementality.
