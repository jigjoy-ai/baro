# ADR-0001: Add a new `src/harness/process-cpu-activity.ts` CPU sampler instead of extending process-tree.ts

**Status:** Accepted
**Context:** The goal assumed a CPU-activity process-tree helper exists; scouts confirmed none does — process-tree.ts reads only state/ppid/pgid/starttime and is a large, safety-critical termination module. Extending its sticky /proc-vs-ps backend selection risks breaking termination guarantees; a separate read-only sampler that reuses its pure traversal is cheaper and independently testable.
**Decision:** Create `packages/baro-orchestrator/src/harness/process-cpu-activity.ts`. It is the SINGLE owner of CPU sampling; no other file may shell out for CPU data.

Exports (exact):
- `export interface CpuActivitySample { readonly at: number; readonly totalCpuMs: number | null; readonly observed: boolean }`
- `export interface ProcessCpuRow { readonly pid: number; readonly parentPid: number; readonly cpuMs: number }`
- `export type ProcessCpuTableReader = () => Promise<readonly ProcessCpuRow[] | null>`
- `export async function sampleProcessTreeCpu(rootPid: number, readTable?: ProcessCpuTableReader): Promise<CpuActivitySample>`
- `export function cpuAdvanced(previous: CpuActivitySample, current: CpuActivitySample, minDeltaMs?: number): boolean`
- `export const CPU_PROBE_TIMEOUT_MS = 5_000;`
- `export const CPU_ADVANCE_MIN_DELTA_MS = 1_000;`

Behaviour:
- Default reader: on `linux`/`darwin` only (reuse `POSIX_PROCESS_GROUPS_SUPPORTED` from `./process-tree.js`), run `ps -Ao pid=,ppid=,time=` via `node:child_process` `execFile` with `timeout: CPU_PROBE_TIMEOUT_MS` and `maxBuffer: 4*1024*1024`; parse each row's `time` as `[[dd-]hh:]mm:ss[.cc]` into ms. Any other platform, spawn error, timeout, or unparsable output ⇒ return `null`.
- `sampleProcessTreeCpu`: table `null` ⇒ `{ at: Date.now(), totalCpuMs: null, observed: false }`. Otherwise select `rootPid` plus `descendantsFromParentPairs(rootPid, rows.map(r => [r.pid, r.parentPid]))` (imported from `./process-tree.js`) and return the summed `cpuMs` with `observed: true`. A vanished root yields `totalCpuMs: 0, observed: true`.
- `cpuAdvanced(previous, current, minDeltaMs = CPU_ADVANCE_MIN_DELTA_MS)`: if either sample has `observed === false` return `true` (unobservable is treated as busy — the absolute ceiling of ADR-003 is the backstop); otherwise return `(current.totalCpuMs! - previous.totalCpuMs!) >= minDeltaMs`.
- Do NOT add any npm dependency; do NOT read `/proc` in this module.
**Consequences:** `ps` 1-second CPU-time resolution is why `CPU_ADVANCE_MIN_DELTA_MS` is 1000ms; probes are only taken at 5-minute idle boundaries so cost is negligible. Windows and probe failures never gain hang protection from this module — they rely entirely on ADR-003's absolute ceiling. Tests inject `readTable` directly; no global mutable test state is introduced.
