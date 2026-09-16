# ADR-0003: Express every kill-capable deadline as a re-arming awake deadline handle, never a single setTimeout

**Status:** Accepted
**Context:** collective-board.ts:3159-3195 already proves the split-deadline pattern (clamp the delay, stamp an epoch, re-read the clock on fire, re-arm if the deadline has not truly passed), but verification-goal-gate.ts:127-137, architect-openai.ts:127-134, run-architect.ts:769 and goal-invariant-reviewer.ts:804-808 all arm one shot and treat the fire as the truth. A single `setTimeout` silently absorbs a suspend, which is exactly the failure the goal targets, and would also silently over-extend the harness timeouts the constraints forbid.
**Decision:** Add to `src/runtime/awake-clock.ts`:

`export interface AwakeDeadline { readonly budget: AwakeBudgetName; readonly timeoutMs: number; awakeRemainingMs(): number; expired(): boolean; close(): void }`
`export function createAwakeDeadline(input: { budget: AwakeBudgetName; timeoutMs: number; onExpired: () => void; clock?: AwakeClock }): AwakeDeadline`

Implementation contract: record `startedAwakeMs = clock.awakeNow()` and `deadlineAwakeMs = startedAwakeMs + Math.max(1, timeoutMs)`. Arm `clock.setTimeout` with `Math.max(0, Math.min(awakeRemainingMs(), AWAKE_SPLIT_MAX_DELAY_MS))`. On fire: re-read `clock.awakeNow()`; if `awakeRemainingMs() > 0`, re-arm and return; only when awake remaining has actually reached 0 call `onExpired()` exactly once. `close()` is idempotent, clears the pending handle and makes later fires no-ops. `expired()` is a pure re-check (`clock.awakeNow() >= deadlineAwakeMs`).

Every adopted site keeps its existing post-hoc absolute re-check and re-expresses it in awake terms (run-architect.ts:852, architect-openai.ts:137) — the timer stays a wake-up, the clock read stays the authority.
**Consequences:** Delays are now capped at 60s instead of 2_147_483_647, so long budgets fire a handful of extra no-op re-arms; observable output is unchanged. A suspend can only push an expiry later (never earlier), satisfying the loosen-only constraint. Harness idle/absolute timeouts cannot be silently extended because expiry is decided by re-reading awake time at each fire, not by the delay that was armed.
