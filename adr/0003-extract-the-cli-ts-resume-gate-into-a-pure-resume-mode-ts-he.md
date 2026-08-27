# ADR-0003: Extract the cli.ts resume gate into a pure `resume-mode.ts` helper that ORs argv and BARO_RESUME

**Status:** Accepted
**Context:** The gate is an inline expression at scripts/cli.ts:806 and cli.ts runs work at import time (argv consumed at :430-437), so it cannot be imported by a unit test; existing cli.ts tests are out-of-process subprocess runs (test/conversation-context-cli.test.ts:9-58). Acceptance needs a fast TS test for argv-only and env-only resume. Alternative rejected: exporting `parseArgs` from cli.ts and importing it — the module's top-level side effects would run inside the test process. Alternative rejected: a subprocess smoke test only — it cannot isolate the gate and lands in the slow lane.
**Decision:** 1. New file `packages/baro-orchestrator/src/runtime/resume-mode.ts` (sits beside the existing `src/runtime/env-flag.ts`), exporting exactly one function:
   `export function resumeRunRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean { return argv.includes("--resume") || env.BARO_RESUME === "1"; }`
   This file is the single owner of the resume-mode predicate. No default export, no other exports, no `process.env` read inside the function.
2. In `packages/baro-orchestrator/scripts/cli.ts`: import it as `import { resumeRunRequested } from "../src/runtime/resume-mode.js";` alongside the existing src imports; at cli.ts:437 replace `parseArgs(process.argv.slice(2))` with a hoisted `const cliArgv = process.argv.slice(2);` + `parseArgs(cliArgv)`; change line 806 to `resumeRun: resumeRunRequested(cliArgv, process.env),`.
3. Keep `case "--resume": args.resume = true; break;` (cli.ts:197-199) and the `resume: boolean` field on `CliArgs` (:65) so the flag is not fatal under the unknown-flag default (:321-323); do not delete `args.resume`.
4. Add one concise `--resume` line to `printHelp` (cli.ts:422-426) matching the surrounding style.
5. Do NOT change `continueRun` (cli.ts:805), `src/orchestrate.ts`, or `src/execution/resume-selection.ts`.
**Consequences:** `BARO_RESUME=1` with no argv flag still enters resume mode, preserving the compatibility seam. Resume mode is now reachable from a flag on the child's own argv, independent of inherited env. Because the helper takes argv and env as arguments, the test needs no subprocess and lands in the fast lane.
