# ADR-0001: Own normalization, notes, and defects in one new module src/contract/contract-normalization.ts

**Status:** Accepted
**Context:** Both flavors need identical key-drift handling, an identical warn-note vocabulary, and an identical defect record, but they live in different trees (src/goal vs src/planning/domain) and there is no shared diagnostic type in the repo (scout Q4). Putting the helper in src/goal would make it look goal-specific; putting it in src/planning/domain would force src/goal to import planning (today the dependency runs planning -> goal only). A new neutral leaf module avoids the cycle.
**Decision:** Create packages/baro-orchestrator/src/contract/contract-normalization.ts as the SINGLE owner of these exports. It must import nothing from src/goal, src/planning, src/execution or src/harness (leaf module).

Types:
- `export type ContractNoteKind = "stripped_unexpected_field" | "canonicalized_field" | "skipped_absent_entry";`
- `export interface ContractNote { readonly severity: "warn"; readonly kind: ContractNoteKind; readonly path: string; readonly detail: string }`
- `export interface ContractDefect { readonly path: string; readonly message: string }`
- `export type NoteSink = (note: ContractNote) => void;`

Functions:
- `export function canonicalFieldKey(key: string): string` — `key.toLowerCase().replace(/[^a-z0-9]/gu, "")`. No edit-distance, no synonym table, no stemming.
- `export function normalizeRecordKeys(candidate: Record<string, unknown>, expectedKeys: readonly string[], path: string, onNote?: NoteSink): Record<string, unknown>` — returns a NEW plain object. Algorithm, in this order: (1) group present keys by `canonicalFieldKey`; (2) if a group whose canonical form matches an expected key contains more than one present key, throw `ContractNormalizationError` with message `` `${path}: fields ${quotedSortedNames} both name "${expected}"` `` (names sorted, each double-quoted, joined with " and ") — this happens even when one of them is an exact match, never silently pick one; (3) a key that exactly equals an expected key is copied through unchanged with no note; (4) a key whose canonical form matches exactly one expected key and differs textually is copied under the expected name, emitting `{severity:"warn", kind:"canonicalized_field", path, detail: `${path}: renamed field "${key}" to "${expected}"`}`; (5) any remaining key is DROPPED, emitting `{severity:"warn", kind:"stripped_unexpected_field", path, detail: `${path}: dropped unexpected field "${key}"`}`. Values are copied by reference and are NEVER inspected, coerced, trimmed, or canonicalized. Missing expected keys are never invented.
- `export class ContractNormalizationError extends Error` with `name = "ContractNormalizationError"` and `readonly path: string`.
- `export function contractDefects(error: unknown): readonly ContractDefect[]` — returns `error.defects` when the value is an object with a non-empty readonly array `defects`, otherwise `[{ path: "", message: error instanceof Error ? error.message : String(error) }]`.
- `export function defectFlavor(defect: ContractDefect): string` — the path prefix up to the first `[` or `.`; `"outcome"` when the path is empty.
- `export function formatDefectList(defects: readonly ContractDefect[]): string` — one line per defect, `` `- ${path ? path + ": " : ""}${message}` ``, joined by `\n`, each message truncated to 400 chars and the whole block truncated to 4000 chars.
- `export function joinDefectMessages(defects: readonly ContractDefect[]): string` — `defects.map(d => d.message).join("; ")`.

Path grammar used everywhere: `constraintPredicates[2].kind`, `obligations[0].evidence[3]`, `questions[1].reason`, `""` for the top-level record.

Do NOT add a generic Result/Either type, do NOT introduce a base error class, do NOT add a logging dependency.
**Consequences:** Every other story imports from this one file; it must land before them. Because normalization only ever drops or renames keys and never fabricates them, required-field presence checks downstream stay exactly as strict. Ambiguity is a hard failure by construction, satisfying the no-silent-pick constraint. Note that `normalizeRecordKeys` throwing on ambiguity means callers must convert that throw into a defect entry (see the accumulation ADR).
