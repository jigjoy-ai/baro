# ADR-0002: Own the dialogue retry policy in a new src/harness/dialogue-retry-policy.ts with BARO_DIALOGUE_RETRY_* env vars

**Status:** Accepted
**Context:** The attempt count and wait ceiling must be env-overridable and unit-testable, but scripts/run-conversation.ts is an entry script with top-level side effects and must not be imported by tests, and src/runtime/env-int.ts reads process.env directly so it cannot be driven from a test without mutating the process. The repository already has an injectable-env precedent (src/integration/repository-command.ts:174-184). One file must own these numbers so the script and the tests cannot disagree.
**Decision:** New file `packages/baro-orchestrator/src/harness/dialogue-retry-policy.ts` exporting:
```ts
export interface DialogueRetryPolicy { maxAttempts: number; maxWaitMs: number; fallbackWaitMs: number }
export const DIALOGUE_RETRY_ATTEMPTS_ENV = "BARO_DIALOGUE_RETRY_ATTEMPTS"
export const DIALOGUE_RETRY_MAX_WAIT_MS_ENV = "BARO_DIALOGUE_RETRY_MAX_WAIT_MS"
export function resolveDialogueRetryPolicy(env: NodeJS.ProcessEnv = process.env): DialogueRetryPolicy
```
Defaults: `maxAttempts` 4, `maxWaitMs` 120_000, `fallbackWaitMs` 15_000 (fixed, not env-overridable). Parsing per variable: read the raw string; if missing/empty/non-finite/non-integer-after-Math.floor/negative, use the default; otherwise clamp — attempts to `Math.max(1, Math.min(8, value))`, maxWaitMs to `Math.max(1_000, Math.min(600_000, value))`. No dependency on src/runtime/env-int.ts (it is not env-injectable). This module must not import run-conversation.ts.
Resulting default wait ladder for a capacity failure with no provider retry-after: attempt 1 → 15_000ms, attempt 2 → 45_000ms, attempt 3 → 120_000ms (135_000 capped), then attempt 4 runs and, on failure, throws.
**Consequences:** Exactly one place defines 4 / 120_000 / 15_000 and the two variable names; the script and every test import them from here. A provider-supplied retry-after still overrides fallbackWaitMs as the base and is still subject to the (now 120s) cap. Clamps mean a hostile or typo'd env value degrades to a sane bound rather than to zero attempts.
