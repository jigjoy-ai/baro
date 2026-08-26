# ADR-0002: Await the bounded flush in scripts/cli.ts only at the three post-orchestrate main() call sites, via an async wrapper that leaves exitAfterTreeCleanup untouched

**Status:** Accepted
**Context:** exitAfterTreeCleanup is declared `never` and its body must stay synchronous so SIGKILL delivery still precedes process.exit (cli.ts:947-951). Awaiting inside it would break the `never` contract for the three non-async callers (cli.ts:901 unhandledRejection, :906 uncaughtException, :944 top-level catch), where deferring the exit would let a faulted process keep running. The goal scopes the flush to 'after orchestrate resolves', which is exactly the three call sites inside async main().
**Decision:** Modify ONLY packages/baro-orchestrator/scripts/cli.ts.

Keep `function exitAfterTreeCleanup(code: number): never { signalAllProcessTrees("SIGKILL"); process.exit(code) }` byte-identical (cli.ts:947-951) — signature, body, ordering, comment.

Add next to it:
```
/** Post-run exits wait for queued TUI lines to reach the pipe; a stuck pipe must not stall shutdown. */
async function exitAfterFlushAndTreeCleanup(code: number): Promise<never> {
    await flushTuiProtocolWithTimeout()
    return exitAfterTreeCleanup(code)
}
```
Import `flushTuiProtocolWithTimeout` from the src barrel path cli.ts already uses for src imports (`../src/tui-protocol.js` unless cli.ts's existing src imports use a different relative prefix — match the file's existing convention exactly).

Replace exactly three call sites, preserving their exit codes:
- cli.ts:864 → `await exitAfterFlushAndTreeCleanup(1)`
- cli.ts:868 → `await exitAfterFlushAndTreeCleanup(0)`
- cli.ts:873 → `await exitAfterFlushAndTreeCleanup(1)`

Leave UNCHANGED: cli.ts:901, :906, :944 (they keep calling the synchronous `exitAfterTreeCleanup(1)`), `shutdown()` (cli.ts:913-923, codes 130/143), the SIGINT/SIGTERM handlers, the orphan watchdog, and `process.exit(2)` at cli.ts:892.

The PR description must state: 'flush is awaited in a new async wrapper exitAfterFlushAndTreeCleanup used at the three post-orchestrate main() exits; fault-path exits are unchanged', and must name TUI_FLUSH_TIMEOUT_MS's value.
**Consequences:** Every exit code and the SIGKILL-then-exit ordering are preserved verbatim; only three call expressions gain `await`. All three sites are already inside `async function main()`, so no callers change shape and the `never` contract is intact for the non-async sites. cli.ts is not covered by tsconfig include and its exit paths are not reachable without spawning a process, so the coverage is on flushTuiProtocolWithTimeout as a pure function (ADR: tests) — the PR description must note this integration gap explicitly.
