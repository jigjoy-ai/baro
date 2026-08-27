# ADR-0001: Add persistPrdPreserving to prd.ts as the single read-merge-write helper, operating on raw JSON rather than PrdFile

**Status:** Accepted
**Context:** The erasure has two distinct mechanisms and one helper must cover both. (a) `goalFingerprint` is not a member of the TS `PrdFile` type at all and is stripped by `normalizePrd`'s whitelist literal (prd.ts:282-291), so it cannot be carried through a typed load→save round-trip; (b) per-story `mergeStatus`/`mergeCommitSha` ARE typed, but a writer holding a stale snapshot (collective-board.ts:1069 → :1580) overwrites the fresher values written by prd-status-writer.ts:64. Rejected: extending `PrdFile` with `goalFingerprint` — the Rust doc comment at executor.rs:65-72 declares the field Rust-owned and never computed by TS; giving TS a typed slot invites TS to author it. Rejected: `loadPrd`-based merge — lossy by construction. Rejected: a per-call-site re-read inside conductor only — leaves the other six sites broken and duplicates the merge rule.
**Decision:** In `packages/baro-orchestrator/src/prd.ts`, immediately after `savePrdAtomic`, add:

```ts
export type PrdPreservedField = "goalFingerprint" | "mergeStatus" | "mergeCommitSha";
export interface PersistPrdPreservingOptions { owns?: readonly PrdPreservedField[] }
export function persistPrdPreserving(path: string, prd: PrdFile, opts?: PersistPrdPreservingOptions): void
```

Algorithm, exactly:
1. `const owns = new Set(opts?.owns ?? [])`.
2. Read the current file raw: `readFileSync(path, "utf8")` → `JSON.parse`. On ANY error (ENOENT, parse failure, non-object result), set `disk = null` — do NOT use `loadPrd` here, since `normalizePrd` would drop the very keys being preserved.
3. `const out: Record<string, unknown> = { ...(prd as unknown as Record<string, unknown>) }`.
4. Top-level preservation: if `disk` is non-null, `!owns.has("goalFingerprint")`, `out.goalFingerprint === undefined`, and `typeof disk.goalFingerprint === "string"`, then `out.goalFingerprint = disk.goalFingerprint`. Preserve NOTHING else at top level — a blanket foreign-key merge would resurrect keys a caller intentionally removed (e.g. `runtimeGraph`).
5. Per-story preservation: build `Map<string, Record<string, unknown>>` from `disk.userStories` (only entries that are objects with a string `id`). Map `out.userStories` = `prd.userStories.map(story => ...)`: for field `mergeStatus`, if `!owns.has("mergeStatus")` and `story.mergeStatus === undefined` and the disk story's `mergeStatus` is exactly `"merged"` or `"failed"`, attach it; for `mergeCommitSha`, if `!owns.has("mergeCommitSha")` and `story.mergeCommitSha === undefined` and the disk value is a `string`, attach it. Stories present on disk but absent from `prd.userStories` are NOT re-added (planner deletions must stick). Never emit an explicit `undefined` value for either field — omit the key, matching normalizeStory (prd.ts:757-764, 780-781).
6. Write atomically. Extract the existing temp+rename body of `savePrdAtomic` into a module-private `writeJsonAtomic(path: string, value: unknown): void` (same `${path}.${process.pid}.${randomUUID()}.tmp`, flag `"wx"`, `JSON.stringify(value, null, 2) + "\n"`, `renameSync`, unlink-and-rethrow on failure) and have BOTH `savePrdAtomic` and `persistPrdPreserving` call it. Do not change `savePrdAtomic`'s exported signature or behaviour.

Do NOT add `goalFingerprint` to the `PrdFile` interface, to `normalizePrd`, or to `PRD_STORY_FIELDS`. Do NOT add any dependency; use only `node:fs`/`node:crypto` already imported at prd.ts:7-8.

A comment block directly above the function (3-6 lines, per the CLAUDE.md comment style) must state: `goalFingerprint` is written by Rust (crates/baro-tui/src/main.rs:3945) and is not a member of `PrdFile`, so `normalizePrd` strips it; per-story `mergeStatus`/`mergeCommitSha` are owned by prd-status-writer.ts; therefore a blind full-file `savePrd`/`savePrdAtomic` from a stale in-memory snapshot silently erases another writer's field, and every full-file writer must go through this function instead.

Re-export `persistPrdPreserving` from `packages/baro-orchestrator/src/main.ts` alongside the existing `savePrd`/`savePrdAtomic` re-exports (main.ts:414-415).
**Consequences:** Merge is last-write-wins for every field except the three named ones; this is a targeted repair of a known lost-update, not a general CAS. Callers that legitimately clear `mergeStatus` must pass `owns: ["mergeStatus"]` — no current src/ caller does. A missing or corrupt prd.json degrades to a plain write of `prd`, preserving today's behaviour. Because the merge output is a raw record rather than a `PrdFile`, downstream readers still see a superset of the typed shape; Rust round-trips it fine (executor.rs:707-717).
