# ADR-0003: Always pass an absolute per-command ceiling from runCmd and re-derive the recommended run timeout

**Status:** Accepted
**Context:** With ADR-002 an unobservable or genuinely busy process could extend indefinitely. `ExecFileCliOptions.timeout` already implements a hard deadline (exec-file-cli.ts:181-189) but `runCmd` (verify.ts:1024-1030) never passes it, so today no per-command ceiling exists at all.
**Decision:** In `packages/baro-orchestrator/src/verification/verify.ts`:
- Add `const ABSOLUTE_COMMAND_TIMEOUT_MS = 10 * 60_000;` beside `IDLE_TIMEOUT_MS` (verify.ts:33).
- `runCmd` passes `timeout: ABSOLUTE_COMMAND_TIMEOUT_MS` in the existing `execFileCli` options object; all other options unchanged.
- In exec-file-cli.ts, the absolute-deadline error message must be `"<command> exceeded the absolute limit of <timeoutMs>ms — terminated"` with `killed = true`, distinct from the idle message, so operators can tell the two kills apart.
- Redefine the recommendation helpers so declared commands are budgeted once and retryable (non-declared, see ADR-004) commands twice. With `unit = ABSOLUTE_COMMAND_TIMEOUT_MS + COMMAND_SETTLEMENT_GRACE_MS + COMMAND_PROCESS_TREE_QUIESCENCE_BUDGET_MS`: `recommendedVerifyTimeoutMs` (verify.ts:930) and `recommendedMergedVerifyTimeoutMs` (verify.ts:947) return `declaredExecutableCount * unit + retryableExecutableCount * 2 * unit + 60_000`.
- Do NOT change the callers at orchestrate.ts:1521 or main.ts:192-193; they keep consuming the helpers.
**Consequences:** Worst-case gate time is bounded and computable: no command can exceed 10 minutes wall clock, and no command can be attempted more than twice. The recommended outer abort budget grows relative to today's value — that is intended and must not be clamped back. Existing tests asserting the old recommendation arithmetic must be updated to the new formula.
