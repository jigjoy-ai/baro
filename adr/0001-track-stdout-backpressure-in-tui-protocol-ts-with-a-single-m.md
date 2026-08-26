# ADR-0001: Track stdout backpressure in tui-protocol.ts with a single module-level drain promise and export flushTuiProtocol()

**Status:** Accepted
**Context:** emit() (tui-protocol.ts:221-224) discards the write() return value, so a `done` line queued in the stream's internal buffer is lost when process.exit runs. process.stdout is a single stream: its 'drain' event means the whole internal buffer has been handed to the OS pipe, so ONE pending promise correctly covers every prior emit(), which is exactly the acceptance requirement. Rejected: per-write promise arrays (unnecessary bookkeeping for a single stream), a write-callback-based counter (callbacks fire per chunk and complicate the existing test stub which ignores the callback), and injecting a configurable output stream (would change 15 import sites and the existing capture helpers for no benefit).
**Decision:** Modify ONLY packages/baro-orchestrator/src/tui-protocol.ts.

Add module-level state near the top of the file:
`let pendingDrain: Promise<void> | null = null`

emit() keeps its exact signature `export function emit(event: BaroEvent): void` and its exact line construction (`JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n"`) — the serialized bytes must not change. Only the write becomes:
```
const accepted = process.stdout.write(line)
if (!accepted && pendingDrain === null) {
    pendingDrain = new Promise<void>(resolve => {
        process.stdout.once("drain", () => { pendingDrain = null; resolve() })
    })
}
```
If a write returns false while `pendingDrain` is non-null, reuse the existing promise (do not register a second 'drain' listener).

Add exports:
- `export function flushTuiProtocol(): Promise<void>` — returns `pendingDrain ?? Promise.resolve()`. It must NOT be `async` in a way that changes the immediate-resolve case's observable behavior beyond one microtask; returning the stored promise directly is required.
- `export const TUI_FLUSH_TIMEOUT_MS = 3_000`
- `export async function flushTuiProtocolWithTimeout(timeoutMs: number = TUI_FLUSH_TIMEOUT_MS, flush: () => Promise<void> = flushTuiProtocol): Promise<"flushed" | "timeout">` — races `flush()` against a timer; the timer handle must be `clearTimeout`-ed in a finally block and created with `.unref?.()` so it can never keep the event loop alive; resolves `"flushed"` or `"timeout"` and never rejects (wrap flush() rejection as `"flushed"`). The injectable `flush` parameter is the pure-function test seam.
- `export function resetTuiProtocolFlushState(): void` — sets `pendingDrain = null`; one-line comment marking it test-only isolation.

Do NOT change the `BaroEvent` union, `DiffFileInfo`, `subscribeCommands`, or any other export. Do NOT modify src/main.ts (the new symbols are imported directly from src/tui-protocol.js). Do NOT touch src/harness/claude/hook-bridge.ts (its direct stdout writes + process.exit are out of scope).
**Consequences:** emit() stays sync `void`, so all 15 importing modules and the existing capture helpers are unaffected. Because 'drain' means the entire buffer flushed, a flush promise returned before a later emit() may also cover that later write — this is strictly stronger than required and is the documented behavior. Module state means tests must resolve the pending drain (or call resetTuiProtocolFlushState) so a leaked promise cannot bleed across cases; node --test isolates per file, so no cross-file risk.
