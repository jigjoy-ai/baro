/**
 * Criteria a review already found satisfied, per story, for one exact
 * changed-content fingerprint. The Critic sees a bounded window of the
 * agent's newest commands, so proof gathered early scrolled out while the
 * agent proved other criteria, and each review failed a different set
 * (seven rejections of one finished story). Same bytes, same verdict:
 * what passed stays passed until the content changes.
 */

export interface LedgerEvaluation {
    readonly status?: "evaluated" | "inconclusive"
    readonly verdict: "pass" | "fail"
    readonly reasoning: string
    readonly violatedCriteria: readonly string[]
    readonly contractConflicts?: readonly { readonly criterion: string }[]
}

export class CriterionLedger {
    private readonly entries = new Map<string, { fingerprint: string; passed: Set<string> }>()

    established(agentId: string, fingerprint: string | null): readonly string[] {
        const entry = this.entries.get(agentId)
        return fingerprint && entry?.fingerprint === fingerprint ? [...entry.passed] : []
    }

    record(
        agentId: string,
        fingerprint: string | null,
        criteria: readonly string[],
        evaluation: LedgerEvaluation,
    ): void {
        if (!fingerprint || (evaluation.status ?? "evaluated") !== "evaluated") return
        // A fail that names nothing proves nothing about any single criterion.
        if (evaluation.verdict === "fail" && evaluation.violatedCriteria.length === 0) return
        const failed = new Set([
            ...evaluation.violatedCriteria,
            ...(evaluation.contractConflicts ?? []).map(({ criterion }) => criterion),
        ])
        const entry = this.entries.get(agentId)
        const passed = entry?.fingerprint === fingerprint ? entry.passed : new Set<string>()
        for (const criterion of criteria) {
            if (!failed.has(criterion)) passed.add(criterion)
        }
        this.entries.set(agentId, { fingerprint, passed })
    }
}

/** Drops violations of criteria already established for this content. */
export function honorEstablished<T extends LedgerEvaluation>(
    evaluation: T,
    established: readonly string[],
): T {
    if (established.length === 0 || evaluation.verdict !== "fail") return evaluation
    if ((evaluation.status ?? "evaluated") !== "evaluated") return evaluation
    const settled = new Set(established)
    const violated = evaluation.violatedCriteria.filter((criterion) => !settled.has(criterion))
    if (violated.length === evaluation.violatedCriteria.length) return evaluation
    const note =
        `(Baro: ${evaluation.violatedCriteria.length - violated.length} listed violation(s) ` +
        "were criteria an earlier review of this exact content already found satisfied; they stand.)"
    return {
        ...evaluation,
        verdict: violated.length === 0 ? "pass" : "fail",
        violatedCriteria: violated,
        reasoning: `${evaluation.reasoning} ${note}`.trim(),
    }
}
