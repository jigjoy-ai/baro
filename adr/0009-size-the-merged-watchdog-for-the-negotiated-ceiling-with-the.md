# ADR-0009: Size the merged watchdog for the negotiated ceiling, with the config override still first

**Status:** Accepted
**Context:** ADR 0008
**Decision:** verify.ts: `export function recommendedMergedVerifyTimeoutMs(baseline: VerifyPlan, declaredLimit: number = MAX_DECLARED_VERIFY_COMMANDS): number`. Compute `const extra = Math.max(0, Math.min(declaredLimit, MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS) - MAX_DECLARED_VERIFY_COMMANDS)` and `const retryable = baselineRetryable + MAX_FINAL_ADDED_VERIFY_COMMANDS + extra`. The rest of the formula is unchanged.

orchestrate.ts watchdog expression: `config.collectiveVerificationTimeoutMs ?? recommendedMergedVerifyTimeoutMs(verifyPlan, MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS)`. Leave recommendedVerifyTimeoutMs unchanged.
**Consequences:** One-argument calls return the same values as before, so the existing assertion near declared-verification.test.ts:1154-1158 passes unchanged. The default backstop grows by 16×2×608_000 ms.
