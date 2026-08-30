# ADR-0002: Announce every canonicalization with a domain-local note bridged to emitPlanActivity("warn")

**Status:** Accepted
**Context:** Canonicalization must never be silent, and it must be visible on the run stream. The existing `NoteSink`/`ContractNote` machinery (contract/contract-normalization.ts:12-29) terminates on stderr in scripts/run-architect.ts:256-259 and its `ContractNoteKind` union is closed; extending it would change contract-normalization.ts, which is a stated non-goal. The only stream-visible planning warn precedent is `emitPlanActivity("warn", …)` (planning/application/plan-events.ts:29-33; canonical use progressive-planning-coordinator.ts:715-719). Domain modules in this repo do not write to stdout/stderr, so the domain must hand out a callback and the application layer must own the emission.
**Decision:** In architecture-obligation-contract.ts declare, next to the existing types:
```ts
export type ObligationNoteKind =
    | "canonicalized_obligation_criterion"
    | "completed_obligation_parent_invariants"

export interface ObligationNote {
    readonly severity: "warn"
    readonly kind: ObligationNoteKind
    readonly storyId: string
    readonly obligationId: string
    readonly detail: string
}

export type ObligationNoteSink = (note: ObligationNote) => void
```
Do NOT touch `ContractNoteKind`, `ContractNote`, or `NoteSink` in src/contract/contract-normalization.ts.

Detail strings (exact):
- criterion: `story ${storyId}: canonicalized paraphrased architecture obligation ${obligationId} criterion text`
- parents: `story ${storyId}: completed parent GoalContract invariant(s) for ${obligationId}: ${ids.join(", ")}`

Emit at most one note per `(storyId, obligationId, kind)` per canonicalization pass (dedupe inside `canonicalizeObligationMappings`).

In src/planning/application/plan-events.ts add the single bridge, the only place these notes reach the stream:
```ts
export function emitObligationNote(note: ObligationNote): void {
    emitPlanActivity("warn", note.detail)
}
```
(plan-events.ts imports the type from ../domain/architecture-obligation-contract.js; the domain never imports the application layer.)

Pass `emitObligationNote` as `onNote` at exactly these call sites: progressive-planning-coordinator.ts:353 and :586, progressive-planner-protocol.ts:225 and :260, final-tail-tolerance.ts:63, runtime-replan.ts:390 and :395. Leave `onNote` undefined at obligation-coverage-report.ts:22 (read-only reporting path, would double-warn). planner-validation.ts:192 passes `emitObligationNote` as well, and its existing process.stderr note at :153-155 stays as-is.
**Consequences:** Every host-side rewrite is announced on the run stream as `{type:"activity", id:"plan", kind:"warn"}`; tests can observe it with the stdout-intercept technique in test/planning/progressive-planning-final-tail.test.ts:670-704. Because `emitPlanActivity` collapses whitespace and drops empty text, detail strings must stay single-line. No stderr path changes; run-architect.ts is untouched.
