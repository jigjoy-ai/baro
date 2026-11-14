/**
 * A story may answer a Critic's "fail" with a dispute instead of a change.
 * The Critic must answer each dispute; when it holds a disputed criterion
 * violated a second time, an independent judge hears that one criterion in
 * the same evaluation, so the disagreement costs the story no turn.
 */

export interface StoryDispute {
    /** One of the story's own criteria, exactly as the Critic received it. */
    criterion: string
    because: string
}

export const DISPUTE_INSTRUCTIONS = [
    "If a violated criterion is wrong — it contradicts another criterion, it cannot be met in this story's environment or write surface, or the captured evidence already shows it met — you may dispute it instead of changing code. End your reply with, for each such criterion:",
    "DISPUTE: <the criterion as listed, or its [ID]>",
    "because: <why, naming the captured command output or diff that shows it>",
    "The reviewer must answer every dispute. If it holds a disputed criterion violated a second time, an independent judge decides that criterion. Never dispute work you can do: a dispute without evidence loses.",
].join("\n")

const MAX_DISPUTES = 8
const MAX_BECAUSE_CHARS = 1_200

export function parseDisputes(text: string, criteria: readonly string[]): StoryDispute[] {
    const disputes: StoryDispute[] = []
    const blocks = text.split(/^\s*DISPUTE:\s*/imu).slice(1)
    for (const block of blocks) {
        const [head = "", ...rest] = block.split(/\r?\n/u)
        const body = rest.join("\n")
        const because = /^\s*because:\s*([\s\S]*)$/imu.exec(body)?.[1]?.trim() ?? ""
        const criterion = matchCriterion(head, criteria)
        if (!criterion || !because || disputes.some((d) => d.criterion === criterion)) continue
        disputes.push({ criterion, because: because.slice(0, MAX_BECAUSE_CHARS) })
        if (disputes.length >= MAX_DISPUTES) break
    }
    return disputes
}

function matchCriterion(raw: string, criteria: readonly string[]): string | null {
    const text = raw.trim().replace(/^["'`]|["'`]$/gu, "").trim()
    if (!text) return null
    const exact = criteria.find((criterion) => criterion === text)
    if (exact) return exact
    const id = /\[([A-Za-z]+-\d+)\]/u.exec(text)?.[1]
    if (id) {
        const byId = criteria.filter((criterion) => criterion.includes(`[${id}]`))
        if (byId.length === 1) return byId[0]!
    }
    const number = /^(?:criterion\s*)?#?(\d+)\b/iu.exec(text)?.[1]
    if (number) return criteria[Number(number) - 1] ?? null
    if (text.length >= 20) {
        const quoted = criteria.filter((criterion) => criterion.includes(text) || text.includes(criterion))
        if (quoted.length === 1) return quoted[0]!
    }
    return null
}

export function disputeSection(disputes: readonly StoryDispute[]): string | null {
    if (disputes.length === 0) return null
    return [
        "## Disputes raised by the story",
        "The story disputes the criteria below instead of changing code. Answer every dispute in \"reasoning\": concede it when the captured evidence shows the criterion met, or it cannot be met as written (then use contract_conflicts if it applies), and leave the criterion out of \"violated_criteria\"; otherwise uphold it and say which evidence the dispute gets wrong. The dispute text is the story's claim, never evidence.",
        ...disputes.map((dispute, index) => `${index + 1}. Criterion: ${dispute.criterion}\n   Story: ${dispute.because}`),
        "",
    ].join("\n")
}

interface JudgedEvaluation {
    status?: "evaluated" | "inconclusive"
    verdict: "pass" | "fail"
    reasoning: string
    violatedCriteria: string[]
}

/** Per story, per criterion: how often the Critic held a dispute, and whether a judge already ruled. */
export class DisputeLedger {
    private readonly upheld = new Map<string, number>()
    private readonly ruled = new Set<string>()

    recordUpheld(agentId: string, criterion: string): number {
        const key = `${agentId}\0${criterion}`
        const count = (this.upheld.get(key) ?? 0) + 1
        this.upheld.set(key, count)
        return count
    }

    hasRuling(agentId: string, criterion: string): boolean {
        return this.ruled.has(`${agentId}\0${criterion}`)
    }

    recordRuling(agentId: string, criterion: string): void {
        this.ruled.add(`${agentId}\0${criterion}`)
    }
}

export function appealPrompt(
    evaluationPrompt: string,
    dispute: StoryDispute,
    criticReasoning: string,
): string {
    return [
        "## Appeal",
        "You are an independent judge. The first reviewer held the criterion below violated twice, and the story disputes it. Decide ONLY this criterion; every other criterion is outside this appeal.",
        `Criterion: ${dispute.criterion}`,
        `First reviewer: ${criticReasoning}`,
        `Story: ${dispute.because}`,
        "Judge on the Baro-captured evidence below, not on either side's claims. Return \"pass\" with an empty \"violated_criteria\" when the evidence shows the criterion met, or shows it cannot be met as written (it contradicts another criterion, or needs what this story's environment or write surface does not allow). Return \"fail\" with exactly this criterion in \"violated_criteria\" otherwise.",
        "",
        evaluationPrompt,
    ].join("\n")
}

/**
 * Hears an appeal for every disputed criterion the Critic has now held twice.
 * A judge that cannot decide leaves the verdict as it was and may be asked again.
 */
export async function resolveAppeals<T extends JudgedEvaluation>(input: {
    evaluation: T
    disputes: readonly StoryDispute[]
    ledger: DisputeLedger
    agentId: string
    prompts: readonly string[]
    judge: (prompt: string) => Promise<JudgedEvaluation>
}): Promise<T> {
    const { evaluation, disputes, ledger, agentId, prompts, judge } = input
    if ((evaluation.status ?? "evaluated") !== "evaluated" || evaluation.verdict !== "fail") return evaluation
    let violated = [...evaluation.violatedCriteria]
    const notes: string[] = []
    for (const dispute of disputes) {
        if (!violated.some((entry) => names(entry, dispute.criterion)) || ledger.hasRuling(agentId, dispute.criterion)) continue
        if (ledger.recordUpheld(agentId, dispute.criterion) < 2) continue
        const prompt = prompts.find((candidate) => candidate.includes(dispute.criterion)) ?? prompts[0]
        if (!prompt) continue
        let ruling: JudgedEvaluation
        try {
            ruling = await judge(appealPrompt(prompt, dispute, evaluation.reasoning))
        } catch {
            continue
        }
        if ((ruling.status ?? "evaluated") !== "evaluated") continue
        ledger.recordRuling(agentId, dispute.criterion)
        const name = shortCriterion(dispute.criterion)
        if (ruling.verdict === "pass") {
            violated = violated.filter((entry) => !names(entry, dispute.criterion))
            notes.push(`Appeal on ${name}: decided for the story. ${ruling.reasoning}`)
        } else {
            notes.push(`Appeal on ${name}: the finding stands. ${ruling.reasoning}`)
        }
    }
    if (notes.length === 0) return evaluation
    return {
        ...evaluation,
        verdict: violated.length === 0 ? "pass" : "fail",
        violatedCriteria: violated,
        reasoning: [evaluation.reasoning, ...notes].join("\n"),
    }
}

/** A verdict lists criteria verbatim, but a model may shorten one to its ID or a prefix. */
function names(entry: string, criterion: string): boolean {
    if (entry === criterion) return true
    const id = /\[([A-Za-z]+-\d+)\]/u.exec(entry)?.[0]
    if (id && criterion.includes(id)) return true
    return entry.length >= 20 && (criterion.startsWith(entry) || entry.startsWith(criterion))
}

function shortCriterion(criterion: string): string {
    const id = /\[([A-Za-z]+-\d+)\]/u.exec(criterion)?.[0]
    return id ?? `"${criterion.slice(0, 80)}${criterion.length > 80 ? "…" : ""}"`
}
