# ADR-0003: Wire run-conversation.ts to the policy and name the env vars in the first stderr retry notice

**Status:** Accepted
**Context:** scripts/run-conversation.ts:279-303 is the single conversation-path call site; it currently passes maxWaitMs 10_000 and no maxAttempts, and its notice writes `[run-conversation] ${message}` on every retry. The requirement is that the variable names appear in the stderr notice on the first retry, without spamming them on every subsequent retry, and that abort/killed still fail closed.
**Decision:** In `packages/baro-orchestrator/scripts/run-conversation.ts`, at the withTransientRetry call (:279):
- call `const retryPolicy = resolveDialogueRetryPolicy()` (import from `../src/harness/dialogue-retry-policy.js`) at the point where the retry options are built, and pass `maxAttempts: retryPolicy.maxAttempts`, `maxWaitMs: retryPolicy.maxWaitMs`, `fallbackWaitMs: retryPolicy.fallbackWaitMs`. Remove the literal `maxWaitMs: 10_000`.
- keep the existing `retryable` veto verbatim (`signal?.aborted !== true && (error as { killed?: boolean }).killed !== true`).
- replace the notice callback with one that carries a local `let noticed = false` and writes:
  first call: `[run-conversation] ${message} (override with ${DIALOGUE_RETRY_ATTEMPTS_ENV}=<attempts> or ${DIALOGUE_RETRY_MAX_WAIT_MS_ENV}=<ms>)\n`
  subsequent calls: `[run-conversation] ${message}\n`
  The flag is scoped to the wrapper invocation, so each contract attempt announces the variables once.
- leave the billing identity logic (`.retry${attempt-1}` / `.repair${attempt-1}`, :276-287) and the startup turn-budget validation (:205-206) unchanged.
No other file may pass fallbackWaitMs or resolveDialogueRetryPolicy.
**Consequences:** Worst case per contract attempt becomes 4 provider calls plus ~180s of waiting; with the intake's 2 contract attempts (conversation-intake.ts:309-326) that is up to 8 provider calls (~14 min at the 60s provider timeout), still inside the 30-min default turn budget, so the :205-206 validation stays as-is. Deterministic failures, aborts and watchdog kills still throw on attempt 1 because classification and the veto are untouched.
