// Import-free on purpose: prd.ts, the planner/replan gates and verify.ts all
// judge budgets here, and any import would risk a cycle between them.

export const MAX_DECLARED_VERIFY_COMMANDS = 8
export const MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS = 24

const MAX_REASON_EVIDENCE_CHARS = 200

export interface DeclaredTestBudgetRequest {
    readonly storyId: string
    readonly testBudget: unknown
}

export interface DeclaredBudgetDecision {
    readonly storyId: string
    readonly status: "accepted" | "rejected"
    readonly commands: number | null
    // The story's reason when accepted, the rejection text when rejected.
    readonly detail: string
}

export interface DeclaredBudgetEvidence {
    readonly defaultLimit: number
    readonly ceiling: number
    readonly effectiveLimit: number
    readonly negotiatedBy: string | null
    readonly decisions: readonly DeclaredBudgetDecision[]
}

export type TestBudgetJudgement =
    | {
          readonly accepted: true
          readonly commands: number
          readonly reason: string
      }
    | { readonly accepted: false; readonly rejection: string }

function plainRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null
    }
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
        ? (value as Record<string, unknown>)
        : null
}

// Order is part of the contract: every gate must report the same first failure.
export function judgeTestBudget(value: unknown): TestBudgetJudgement {
    const record = plainRecord(value)
    if (!record) {
        return {
            accepted: false,
            rejection:
                "testBudget must be an object with integer commands and a non-empty reason",
        }
    }
    const { commands, reason } = record
    if (typeof reason !== "string" || reason.trim() === "") {
        return {
            accepted: false,
            rejection: "testBudget.reason must be a non-empty string",
        }
    }
    if (typeof commands !== "number" || !Number.isInteger(commands)) {
        return {
            accepted: false,
            rejection: "testBudget.commands must be an integer",
        }
    }
    if (commands <= MAX_DECLARED_VERIFY_COMMANDS) {
        return {
            accepted: false,
            rejection: `testBudget.commands must be above the default ${MAX_DECLARED_VERIFY_COMMANDS}`,
        }
    }
    if (commands > MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS) {
        return {
            accepted: false,
            rejection: `testBudget.commands must be at most ${MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS}`,
        }
    }
    return { accepted: true, commands, reason: reason.trim() }
}

// Reasons are model-authored and end up in logs; keep them to one bounded line.
function reasonEvidence(reason: string): string {
    return reason
        .slice(0, MAX_REASON_EVIDENCE_CHARS)
        .replace(/[\u0000-\u001f\u007f-\u009f`]/g, "?")
}

export function resolveDeclaredBudget(
    requests: readonly DeclaredTestBudgetRequest[],
): DeclaredBudgetEvidence {
    const decisions: DeclaredBudgetDecision[] = []
    let effectiveLimit = MAX_DECLARED_VERIFY_COMMANDS
    let negotiatedBy: string | null = null
    for (const request of requests) {
        const judgement = judgeTestBudget(request.testBudget)
        if (judgement.accepted) {
            decisions.push({
                storyId: request.storyId,
                status: "accepted",
                commands: judgement.commands,
                detail: reasonEvidence(judgement.reason),
            })
            if (judgement.commands > effectiveLimit) {
                effectiveLimit = judgement.commands
                negotiatedBy = request.storyId
            }
            continue
        }
        const rawCommands = plainRecord(request.testBudget)?.commands
        decisions.push({
            storyId: request.storyId,
            status: "rejected",
            commands: typeof rawCommands === "number" ? rawCommands : null,
            detail: judgement.rejection,
        })
    }
    return {
        defaultLimit: MAX_DECLARED_VERIFY_COMMANDS,
        ceiling: MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS,
        effectiveLimit,
        negotiatedBy,
        decisions,
    }
}

export function formatDeclaredBudgetEvidence(
    evidence: DeclaredBudgetEvidence,
): string[] {
    return evidence.decisions.map((decision) =>
        decision.status === "accepted"
            ? `testBudget accepted for story ${decision.storyId}: ${decision.commands} commands (${decision.detail}); effective limit ${evidence.effectiveLimit}`
            : `testBudget rejected for story ${decision.storyId}: ${decision.detail}; effective limit ${evidence.effectiveLimit}`,
    )
}
