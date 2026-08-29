# ADR-0001: Own the denylist in src/contract/contract-normalization.ts and enforce it inside normalizeRecordKeys

**Status:** Accepted
**Context:** The goal forbids ad-hoc checks spread across callers. normalizeRecordKeys is the one function every drift-tolerant path already goes through (outcome root/questions/evidence, obligation segment root/obligations[i], constraintPredicates[i]). Adding checks in architect-outcome.ts and architect-obligation-segments.ts separately would drift apart.
**Decision:** Modify only packages/baro-orchestrator/src/contract/contract-normalization.ts to add, and export:

1. `export const HOST_ASSIGNED_CORRELATION_FIELDS: readonly string[]` — the denylist, source spellings (exact contents in the next decision).
2. `export class ContractAuthorityFieldError extends ContractNormalizationError` with `readonly field: string` (the offending key as spelled by the model) and `name = "ContractAuthorityFieldError"`; constructor `(field: string, path: string)` builds the message itself (format fixed in a later decision).
3. `export function isHostAssignedCorrelationField(key: string): boolean` — returns true when `canonicalFieldKey(key)` is a member of a module-private `Set<string>` built once from `HOST_ASSIGNED_CORRELATION_FIELDS.map(canonicalFieldKey)`. Matching is canonical, so `session_id`, `SessionID`, `session-id` all match.
4. `export function assertNoHostAssignedCorrelation(candidate: Record<string, unknown>, path: string): void` — iterates `Object.keys(candidate)` in insertion order and throws `ContractAuthorityFieldError(key, path)` on the first match; returns void otherwise.

`normalizeRecordKeys` calls `assertNoHostAssignedCorrelation(candidate, path)` as its FIRST statement, before the existing canonical-collision detection (:81-89) and before any note is emitted, so a denylisted field wins deterministically over a collision defect and produces no `stripped_unexpected_field` note. No other behavior in the module changes: exact-spelling passthrough, `canonicalized_field` renames, and `stripped_unexpected_field` drops for every non-denylisted key stay byte-identical.

Do NOT add a result union, do NOT change ContractNote/ContractDefect shapes, do NOT add a dependency.
**Consequences:** All five normalizeRecordKeys call sites (architect-outcome.ts:528, :579, :638; architect-obligation-segments.ts:456, :485; goal-constraint-appendix.ts:120) inherit fail-closed behavior with no edit. ContractAuthorityFieldError extends ContractNormalizationError, so every existing `catch (error) { if (error instanceof ContractNormalizationError) ... }` keeps working and callers only need to add an `instanceof ContractAuthorityFieldError` refinement where the message must differ. Nested records that callers do not route through normalizeRecordKeys are not covered by this decision alone — see the decision on tolerated-surplus paths.
