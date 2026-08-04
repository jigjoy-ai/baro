/**
 * A contract may state a decision the run must honour, and it may state facts
 * about the repository it is deciding for. The first is authority; the second
 * is just a claim, and a claim can be wrong: in one day of live runs the
 * contract asserted a test command that runs zero tests, an import that fails
 * under jest, and an enum member that does not exist. Each was found by a
 * story agent within minutes and worked around in silence, while the Critic
 * went on judging against the false text for the rest of the run.
 *
 * So a story may withdraw a claim — never a decision — and only by producing
 * the command whose output refutes it. The host writes the amendment; the
 * model only brings evidence. The amendment annotates, it does not pardon:
 * the criterion still stands, judged by what it was for rather than by a
 * literal that turned out to be impossible.
 */

import {
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "../../runtime/mozaik.js"
import {
    ArchitecturePremiseAmended,
    ArchitecturePremiseDisputed,
} from "../../semantic-events.js"

export const MAX_PREMISE_AMENDMENTS = 8
const MAX_OUTPUT_CHARS = 2_000
export const PREMISE_AMENDMENT_HEADING = "## Amendments (evidence-backed)"

export interface PremiseAmendment {
    storyId: string
    claim: string
    command: string
    output: string
    obligationId?: string
    ordinal: number
}

/** Render the amendment block appended to the decision document. */
export function renderPremiseAmendments(
    amendments: readonly PremiseAmendment[],
): string {
    if (amendments.length === 0) return ""
    return [
        "",
        PREMISE_AMENDMENT_HEADING,
        "A story ran a command whose output refutes a factual claim made above.",
        "The decisions stand unchanged. Where an amendment names an obligation,",
        "judge that criterion by the outcome it exists to protect, not by a",
        "literal this repository cannot satisfy.",
        "",
        ...amendments.map((amendment) =>
            [
                `### Amendment ${amendment.ordinal}` +
                    (amendment.obligationId ? ` — ${amendment.obligationId}` : ""),
                `**Withdrawn claim:** ${amendment.claim}`,
                `**Raised by:** ${amendment.storyId}`,
                `**Evidence:** \`${amendment.command}\``,
                "```",
                amendment.output.slice(0, MAX_OUTPUT_CHARS),
                "```",
                "",
            ].join("\n"),
        ),
    ].join("\n")
}

/** Strip a previous amendment block so re-rendering never nests them. */
export function withoutPremiseAmendments(document: string): string {
    const at = document.indexOf(PREMISE_AMENDMENT_HEADING)
    return at < 0 ? document : document.slice(0, at).trimEnd()
}

export function decisionDocumentWithAmendments(
    document: string,
    amendments: readonly PremiseAmendment[],
): string {
    return `${withoutPremiseAmendments(document)}\n${renderPremiseAmendments(amendments)}`
        .trimEnd()
}

export interface PremiseAmendmentAuthorityOptions {
    runId: string
    /** Persist the amended document; the host owns the write, not the model. */
    persist: (document: string) => void
    /** Read the document as it stands, amendments included. */
    read: () => string | null
    maxAmendments?: number
    onProgress?: (line: string) => void
}

/**
 * Turns evidence-backed disputes into amendments, bounded like a replan
 * budget: a run that spends its budget disputing is not converging, and the
 * remaining claims stay as the Architect wrote them.
 */
export class PremiseAmendmentAuthority extends BaseObserver {
    private readonly amendments: PremiseAmendment[] = []

    constructor(private readonly opts: PremiseAmendmentAuthorityOptions) {
        super()
    }

    get applied(): readonly PremiseAmendment[] {
        return this.amendments
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!ArchitecturePremiseDisputed.is(event)) return
        const data = event.data
        if (data.runId !== this.opts.runId) return
        const limit = this.opts.maxAmendments ?? MAX_PREMISE_AMENDMENTS
        if (this.amendments.length >= limit) {
            this.opts.onProgress?.(
                `[premise] dispute from ${data.storyId} exceeds the amendment ` +
                    `budget of ${limit}; the claim stands as written`,
            )
            return
        }
        // The same claim withdrawn twice is one amendment: stories retrying
        // rediscover the same falsehood, and the record should not grow with
        // each attempt.
        if (this.amendments.some((amendment) => amendment.claim === data.claim)) {
            return
        }
        const document = this.opts.read()
        if (!document) {
            this.opts.onProgress?.(
                "[premise] no decision document to amend; the dispute is recorded only",
            )
            return
        }
        const amendment: PremiseAmendment = {
            storyId: data.storyId,
            claim: data.claim,
            command: data.command,
            output: data.output,
            ...(data.obligationId ? { obligationId: data.obligationId } : {}),
            ordinal: this.amendments.length + 1,
        }
        this.amendments.push(amendment)
        this.opts.persist(
            decisionDocumentWithAmendments(document, this.amendments),
        )
        this.opts.onProgress?.(
            `[premise] amendment ${amendment.ordinal}` +
                (amendment.obligationId ? ` (${amendment.obligationId})` : "") +
                `: ${amendment.claim.slice(0, 120)}`,
        )
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(
                this,
                ArchitecturePremiseAmended.create({
                    runId: this.opts.runId,
                    storyId: amendment.storyId,
                    claim: amendment.claim,
                    ...(amendment.obligationId
                        ? { obligationId: amendment.obligationId }
                        : {}),
                    ordinal: amendment.ordinal,
                }),
            )
        }
    }
}
