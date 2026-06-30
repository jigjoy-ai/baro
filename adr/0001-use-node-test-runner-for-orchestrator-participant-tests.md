# ADR-0001: Use Node test runner for orchestrator participant tests

**Status:** Accepted
**Context:** Existing orchestrator tests already use `node:test`; `@baro/memory` uses Vitest, but that convention is package-local and should not be introduced into `@baro/orchestrator` without need.
**Decision:** Add participant unit tests using `import { describe, it, beforeEach, afterEach } from "node:test"` and `import assert from "node:assert/strict"`. Do not add Vitest, Jest, Sinon, or new test dependencies to `packages/baro-orchestrator`. Add these scripts to `packages/baro-orchestrator/package.json`: `"test": "node --import tsx --test \"test/**/*.test.ts\""` and `"test:participants": "node --import tsx --test \"test/participants/**/*.test.ts\""`.
**Consequences:** Implementation agents run `npm --workspace @baro/orchestrator test:participants` for the new suite and `npm --workspace @baro/orchestrator test` for all orchestrator tests. Tests remain outside `dist` and no `tsconfig.json` include change is needed.
