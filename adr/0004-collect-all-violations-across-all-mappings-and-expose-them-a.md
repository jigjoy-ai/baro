# ADR-0004: Collect all violations across all mappings and expose them as a structured `violations` field on ArchitectureObligationContractError

**Status:** Accepted
**Context:** The validator throws on the first violation it meets (:303, :315, :323), so a plan with three distinct defects needs three planner round-trips. `ArchitectureObligationContractError` (:54-63) already models machine-readable detail through `missingObligationIds`, read by `missingObligationIdsFromError` (:65-69) at planner-bus-session.ts:523; that pattern is the template to extend, not replace. Fatality moments must not move: any violation still throws.
**Decision:** Add to architecture-obligation-contract.ts:
```ts
export type ArchitectureObligationViolationKind =
    | "unknown_obligation"
    | "compound_claim"
    | "altered_canonical"
    | "duplicate_owner"
    | "missing_parent_invariants"
    | "unowned_obligation"

export interface ArchitectureObligationViolation {
    readonly kind: ArchitectureObligationViolationKind
    readonly storyId: string        // "" for unowned_obligation
    readonly obligationId: string
    readonly detail: string         // the exact legacy message string for this branch
}
```
Extend the class, keeping `missingObligationIds` and its position:
```ts
constructor(
    message: string,
    missingObligationIds: readonly string[] = [],
    violations: readonly ArchitectureObligationViolation[] = [],
)
```
with `readonly violations: readonly ArchitectureObligationViolation[]`, and add `export function violationsFromError(error: unknown): readonly ArchitectureObligationViolation[]` beside `missingObligationIdsFromError`, returning `[]` for non-instances.

Rewrite `validateArchitectureObligationCoverage` so the mapping/criterion loops push into a local `violations` array instead of throwing, then continue scanning (on `duplicate_owner`, keep the first owner and do not overwrite `owners`; on any per-criterion violation, do not register ownership for that criterion). `detail` for each kind reuses the existing message strings byte-for-byte, including `story ${storyId} altered canonical architecture obligation ${id}` and `story ${mapping.storyId} owns ${exact.id} but omits parent GoalContract invariant(s): ${missingParents.join(", ")}`.

After the loops compute covered/missing as today (:331-336). If `mode === "complete"` and `missingObligationIds.length > 0`, append one `unowned_obligation` violation per missing id with `storyId: ""` and detail `architecture obligation ${id} has no evidence owner`.

If `violations.length > 0`, throw once:
- message when exactly one violation: that violation's `detail` (unchanged legacy string), except the incomplete-coverage case which keeps its legacy message `architecture obligation coverage is incomplete; no story owns: ${missingObligationIds.join(", ")}`;
- message when more than one: `${violations.length} architecture obligation violations: ` + `details.join("; ")`, capped at the first 12 details with `… (+K more)` appended;
- second constructor arg: `missingObligationIds` when the throw includes unowned obligations (unchanged for existing consumers), `[]` otherwise;
- third arg: the full `violations` array, never truncated.
Otherwise return `{ coveredObligationIds, missingObligationIds }` as today.
**Consequences:** Fatality is unchanged: the same inputs that threw before still throw, and `mode === "partial"` still never throws for unowned obligations alone. planner-bus-session.ts:523/:568/:610 keeps working because `missingObligationIds` is still populated on the incomplete-coverage throw. Consumers that only read `error.message` (architect-obligation-segments.ts:596-601, final-tail-tolerance.ts:78-84, obligation-coverage-report.ts:27-30, runtime-replan.ts:414-419, progressive-planning-coordinator.ts:364-370/:603-614) are unaffected but now see multi-violation messages; none of them parse the message, so no edits are required there.
