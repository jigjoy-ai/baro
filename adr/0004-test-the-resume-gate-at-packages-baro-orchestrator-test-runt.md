# ADR-0004: Test the resume gate at packages/baro-orchestrator/test/runtime/resume-mode.test.ts

**Status:** Accepted
**Context:** Package convention: tests mirror src under `test/`, named `<subject>.test.ts`, using `node:test` + `node:assert/strict` and restoring env in `finally` (test/runtime/env-flag.test.ts:1-33). Runner is `node --import tsx --test` (package.json:15).
**Decision:** Create `packages/baro-orchestrator/test/runtime/resume-mode.test.ts` importing `{ resumeRunRequested } from "../../src/runtime/resume-mode.js"`, with `describe`/`it` and `assert` from `node:assert/strict`. Cases, all passing an explicit `env` object literal so `process.env` is never mutated:
- argv `["--resume"]` with `{}` → true (argv alone, no BARO_RESUME);
- argv `["--prd","prd.json"]` with `{ BARO_RESUME: "1" }` → true (env-only backward compatibility);
- argv `[]` with `{}` → false;
- argv `[]` with `{ BARO_RESUME: "0" }` → false;
- argv `["--resume"]` with `{ BARO_RESUME: "1" }` → true.
Do not add a subprocess cli.ts smoke test for resume.
**Consequences:** Story verification is `npm run typecheck` and `node --import tsx --test test/runtime/resume-mode.test.ts`, both run from `packages/baro-orchestrator` with the already-installed root dependencies; the repo-wide suite is not re-run.
