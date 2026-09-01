# ADR-0004: Make the CPU-idleness threshold window-relative so a near-idle process still reads idle

**Status:** Accepted
**Context:** cpuAdvanced (process-cpu-activity.ts:115-123) compares a raw delta against CPU_ADVANCE_MIN_DELTA_MS = 1_000. With the ADR-003 baseline the comparison window can be short (the injected-clock tests measure only milliseconds of real time) or very long (180-300s in production). A fixed 1s floor alone makes a briefly-booting-then-idle process look busy in long windows and makes a fully busy process look idle in short ones. The samples already carry `at`, so elapsed time is available without a signature change.
**Decision:** In packages/baro-orchestrator/src/harness/process-cpu-activity.ts keep `export const CPU_ADVANCE_MIN_DELTA_MS = 1_000` and `CPU_PROBE_TIMEOUT_MS = 5_000` (both pinned by test/harness/process-cpu-activity.test.ts:98-101). Add `export const CPU_ACTIVE_MIN_FRACTION = 0.05`. Change only the comparison inside `cpuAdvanced(previous, current)` (signature unchanged) to:
`const elapsedMs = Math.max(0, current.at - previous.at)`
`const required = Math.max(CPU_ADVANCE_MIN_DELTA_MS, elapsedMs * CPU_ACTIVE_MIN_FRACTION)`
`return current.totalCpuMs - previous.totalCpuMs >= required`
Unobservable-means-busy short-circuits (process-cpu-activity.ts:121) stay ahead of this computation, unchanged. This is the single owner of CPU-idleness; no caller may re-implement a threshold.
**Consequences:** A process that burned only tens of ms of CPU across a window reads idle, which is what makes ADR-003 kill the fixture at exec-file-cli.test.ts:205; a process sustaining >=5% of one core across a long window reads busy and is spared. process-cpu-activity.test.ts may need one added case for the fraction branch (allowed by ADR-005); its existing delta cases keep passing because the 1s floor still dominates for small `at` gaps.
