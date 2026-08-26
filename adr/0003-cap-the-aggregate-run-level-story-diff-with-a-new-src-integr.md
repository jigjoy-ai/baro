# ADR-0003: Cap the aggregate run-level story_diff with a new src/integration/run-diff-cap.ts module

**Status:** Accepted
**Context:** The aggregate emit is inline in orchestrate() (orchestrate.ts:1955-1968) and reachable today only via a full orchestrate() run with real git plus emitTuiEvents:true — a combination no test uses. A pure, separately-owned helper gives the required unit seam without loading orchestrate's dependency graph. Rejected: putting the cap inside getDiff (src/integration/git.ts:361), because getDiff also feeds the per-story emit at git-coordinator.ts:423, which must stay unchanged; and exporting the helper from orchestrate.ts, which would force tests to import that heavy module.
**Decision:** Create packages/baro-orchestrator/src/integration/run-diff-cap.ts exporting exactly:
```
export const MAX_RUN_DIFF_BYTES = 256 * 1024
export function capRunDiff(diff: string | undefined): string | undefined
```
Semantics of capRunDiff (UTF-8 bytes throughout, via Buffer):
1. If `diff` is undefined or "", return it unchanged.
2. `const buf = Buffer.from(diff, "utf8")`; if `buf.byteLength <= MAX_RUN_DIFF_BYTES`, return the SAME string reference unchanged (byte-identical pass-through).
3. Otherwise take `head = buf.subarray(0, MAX_RUN_DIFF_BYTES)`; `const cut = head.lastIndexOf(0x0a)`. If `cut < 0`, `kept = ""` and `keptBytes = 0`; else `kept = head.subarray(0, cut + 1).toString("utf8")` and `keptBytes = cut + 1` (the kept text therefore always ends with a newline, so the marker occupies its own line and no multi-byte character is ever split).
4. `const omitted = buf.byteLength - keptBytes`.
5. Return `` kept + `… (run diff truncated: ${omitted} bytes omitted)` `` — NO trailing newline, matching the existing convention at git.ts:391-395 and the tui-protocol.ts:216-220 rule that fields carry no trailing newline.

Modify packages/baro-orchestrator/src/orchestrate.ts at the aggregate emit only (orchestrate.ts:1955-1968): import `capRunDiff` from `./integration/run-diff-cap.js` and change the payload field to `diff: capRunDiff(runDiff.diff || undefined)`. Everything else at that site — the `useGit && baseSha` and `emitTui` guards, `id: "(run)"`, `files: runDiff.files`, ordering before the `done` event — is unchanged.

Do NOT modify src/integration/git-coordinator.ts (per-story emit at :417-433), src/integration/git.ts (getDiff, DIFF_LINE_CAP), src/tui-protocol.ts's story_diff type, or anything under crates/.
**Consequences:** `files` is never touched, so the TUI's file list stays complete in all cases. Under-cap diffs are the identical string, so existing output is byte-for-byte unchanged and the Rust reader needs no change. getDiff's 180-line cap still applies first, so the byte cap only engages for diffs with very long single lines (e.g. minified or binary-ish content) — that is the intended failure mode being fixed. The marker text is a stable literal that the new tests assert on; changing it later is a test-visible change.
