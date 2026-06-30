# ADR-0002: Keep the existing Node test runner and dependency set

**Status:** Accepted
**Context:** `@baro/orchestrator` already uses Node’s built-in test runner with `tsx`; `@baro/memory` uses Vitest, but that is package-local. Adding another test runner would create unnecessary cross-package inconsistency.
**Decision:** Write new participant tests with `import { describe, it, beforeEach, afterEach } from "node:test"` as needed and `import assert from "node:assert/strict"`. Do not add Vitest, Jest, Sinon, testdouble, mock-fs, or any new package dependency. Leave `packages/baro-orchestrator/package.json` scripts unchanged.
**Consequences:** Verification remains `npm --workspace @baro/orchestrator test:participants` for participant coverage and `npm --workspace @baro/orchestrator test` for the orchestrator package. No `tsconfig.json` change is needed because tests are run through `tsx` and are not part of the package build include.
