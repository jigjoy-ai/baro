/**
 * Host-side repair of `[G-…]` acceptance claims: WHICH invariant a story owns
 * is the planner's decision, the statement text is the ledger's and never the
 * planner's to edit. Mirrors the architecture-obligation twin.
 */

import type { GoalContract, GoalInvariant } from "../../goal/goal-contract.js"

const INVARIANT_CRITERION_CLAIM = /\[(G-[^\]]+)\]/u
const INVARIANT_ID = /^G-[AC][1-9]\d*$/u

export function renderGoalInvariantCriterion(invariant: GoalInvariant): string {
    return `[${invariant.id}] ${invariant.text}`
}

export type GoalInvariantNoteKind = "canonicalized_invariant_criterion"

export interface GoalInvariantNote {
    readonly severity: "warn"
    readonly kind: GoalInvariantNoteKind
    readonly storyId: string
    readonly invariantId: string
    readonly detail: string
}

export type GoalInvariantNoteSink = (note: GoalInvariantNote) => void

/** Idempotent: canonical text compares byte-exact, so it re-runs silently. */
export function canonicalInvariantAcceptance(
    contract: GoalContract | null | undefined,
    storyId: string,
    acceptance: readonly string[],
    onNote?: GoalInvariantNoteSink,
): { acceptance: string[]; invariantIds: string[]; changed: boolean } {
    if (!contract) {
        return { acceptance: [...acceptance], invariantIds: [], changed: false }
    }
    const byId = new Map(
        contract.invariants.map((invariant) => [invariant.id, invariant] as const),
    )
    const announced = new Set<string>()
    const invariantIds: string[] = []
    const result: string[] = []
    let changed = false
    const record = (id: string): void => {
        if (!invariantIds.includes(id)) invariantIds.push(id)
    }
    for (const criterion of acceptance) {
        const claim = INVARIANT_CRITERION_CLAIM.exec(criterion)
        if (!claim) {
            result.push(criterion)
            continue
        }
        const raw = (claim[1] ?? "").trim()
        const parts = raw.split(/[\s/,+&]+/u).filter(Boolean)
        const invariant =
            parts.length === 1 && INVARIANT_ID.test(parts[0]!)
                ? byId.get(parts[0]!)
                : undefined
        // Unknown ids, compound claims and malformed tokens stay verbatim and
        // keep their raw claim, so the existing validators reject them rather
        // than this repairing a fabrication into something plausible.
        if (!invariant) {
            result.push(criterion)
            record(raw)
            continue
        }
        const canonical = renderGoalInvariantCriterion(invariant)
        if (canonical !== criterion) {
            changed = true
            const kind: GoalInvariantNoteKind = "canonicalized_invariant_criterion"
            const key = `${storyId} ${invariant.id} ${kind}`
            if (onNote && !announced.has(key)) {
                announced.add(key)
                onNote({
                    severity: "warn",
                    kind,
                    storyId,
                    invariantId: invariant.id,
                    detail: `story ${storyId}: canonicalized paraphrased goal invariant ${invariant.id} criterion text`,
                })
            }
        }
        result.push(canonical)
        record(invariant.id)
    }
    return { acceptance: result, invariantIds, changed }
}
