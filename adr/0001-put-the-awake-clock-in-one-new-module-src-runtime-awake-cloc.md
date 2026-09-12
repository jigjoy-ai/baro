# ADR-0001: Put the awake clock in one new module `src/runtime/awake-clock.ts` that owns the threshold, the budget names and the fake

**Status:** Accepted
**Context:** Every budget site currently rolls its own `Date.now()` origin, so gap compensation would otherwise be re-derived (and re-thresholded) in eight places. declared-test-budget.ts shows the repo's accepted answer: a single import-free module that every judge imports. named-timers.ts is a timer registry only and must not grow a clock.
**Decision:** Create `packages/baro-orchestrator/src/runtime/awake-clock.ts`. It imports nothing from the repo (only Node built-ins) so any module may depend on it without cycles. Exports, exactly:

`export const SUSPENSION_GAP_THRESHOLD_MS = 2_000`
`export const AWAKE_SPLIT_MAX_DELAY_MS = 60_000`
`export type AwakeBudgetName = "architect-phase" | "architect-obligations" | "architect-round" | "board-soft-deadline" | "conductor-soft-deadline" | "verification-gate" | "goal-completion-gate" | "goal-review" | "exec-file-cli-idle" | "exec-file-cli-absolute" | "harness-liveness" | "cpu-activity"`
`export interface SuspensionGap { readonly gapMs: number; readonly detectedAtWallMs: number }`
`export interface AwakeClock { wallNow(): number; awakeNow(): number; absorbedGapMs(): number; sample(): SuspensionGap | null; onGapAbsorbed(listener: (gap: SuspensionGap) => void): () => void; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }`
`export function createAwakeClock(): AwakeClock`
`export function sharedAwakeClock(): AwakeClock` — lazily created process singleton; the default for every production call site.
`export interface FakeAwakeClock extends AwakeClock { advance(ms: number): void; suspend(ms: number): void; runPending(): void; pendingDelays(): readonly number[] }`
`export function createFakeAwakeClock(options?: { startWallMs?: number }): FakeAwakeClock`

Semantics, binding on all adopters:
- Internally the clock holds `lastWallMs = Date.now()`, `lastMonotonicMs = performance.now()` (Node built-in `perf_hooks`; do NOT add a dependency and do NOT use `process.hrtime`) and `absorbedMs` (starts 0, only ever increases).
- `sample()` reads both sources, computes `drift = wallDelta - monotonicDelta`; if `drift >= SUSPENSION_GAP_THRESHOLD_MS` it adds `drift` to `absorbedMs`, updates both baselines, notifies listeners and returns the gap; otherwise it updates baselines and returns `null`.
- `awakeNow()` calls `sample()` first, then returns `wallNow() - absorbedMs`. Because `absorbedMs` is monotone non-decreasing and never negative, `awakeNow() <= wallNow()` always holds and every derived deadline can only move later in wall time, never earlier.
- `setTimeout`/`clearTimeout` are thin pass-throughs on the real clock (opaque `unknown` handles, exactly as `ExecFileCliTimers`), so a fake clock also fakes timers.
- `createFakeAwakeClock`: `advance(ms)` moves wall and monotonic together (no gap) and fires due timers; `suspend(ms)` moves wall only (produces a gap on the next `sample()`) and fires due timers; `runPending()` fires all currently-due timers. No real timers, no real sleeping.
**Consequences:** Threshold and split cap exist once; no adopter may define its own constant or its own `performance.now()` read. Sampling is lazy (on clock reads and timer fires) — no new interval, no busy-loop. On a machine that never sleeps `drift` stays under the threshold, `absorbedMs` stays 0 and `awakeNow() === Date.now()`, so all adopted sites behave identically to today.
