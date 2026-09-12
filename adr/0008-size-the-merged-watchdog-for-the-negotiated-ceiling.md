# ADR-0008: Size the merged watchdog for the negotiated ceiling

**Status:** Accepted
**Context:** orchestrate.ts:1521 computes the Board watchdog once, at run start, from the baseline plan. Progressive planning and runtime replans can add a larger budget later, so sizing from the start-time PRD could leave the watchdog too small. Each command already has an absolute 10-minute timeout, so the watchdog is only a backstop.
**Decision:** Change the signature to `recommendedMergedVerifyTimeoutMs(baseline: VerifyPlan, declaredLimit: number = MAX_DECLARED_VERIFY_COMMANDS)`.
- `extra = Math.max(0, Math.min(declaredLimit, MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS) - MAX_DECLARED_VERIFY_COMMANDS)`.
- `retryable = baselineRetryable + MAX_FINAL_ADDED_VERIFY_COMMANDS + extra`, with two attempts each, matching `finalAddedLimit`, which may be filled by detected commands.

`recommendedVerifyTimeoutMs` is unchanged; it already scales with the admitted executable count.

orchestrate.ts:1521: `recommendedMergedVerifyTimeoutMs(verifyPlan, MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS)`. The `config.collectiveVerificationTimeoutMs` override still wins.
**Consequences:** The one-argument call and the existing assertion at declared-verification.test.ts:1154-1158 are unchanged. The default backstop grows by 16×2×608s, which is accepted as the price of never being too small.
