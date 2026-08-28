import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AgenticEnvironment, BaseObserver } from "../src/runtime/mozaik.js"
import type { AgenticEnvironment as Env, Participant } from "../src/runtime/mozaik.js"
import { AgentResult } from "../src/semantic-events.js"
import { registerLane } from "../src/harness/lane-registry.js"
import type {
    InteractiveLaneAdapter,
    LaneGrant,
} from "../src/harness/lane-adapter.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "../src/harness/interactive-participant.js"
import { runArchitectBusSession } from "../src/planning/adapters/architect-bus-session.js"
import { ARCHITECT_OUTCOME_SCHEMA_SUMMARY } from "../src/planning/domain/architect-outcome.js"
import type { ContractDefect } from "../src/contract/contract-normalization.js"

/** A validator failure that carries per-entry defects, as the real ones do. */
class DefectiveOutcomeError extends Error {
    readonly defects: readonly ContractDefect[]

    constructor(defects: readonly ContractDefect[]) {
        super(defects.map((defect) => defect.message).join("; "))
        this.name = "DefectiveOutcomeError"
        this.defects = defects
    }
}

/**
 * The Architect reduced to what settleOutcome actually needs: it answers the
 * next scripted line every time the host says something, and keeps every
 * prompt the host sent so a test can read the repair text verbatim. No
 * process, no provider, no network.
 */
class ScriptedOutcomeParticipant
    extends BaseObserver
    implements InteractiveModelParticipant<unknown>
{
    readonly done: Promise<unknown>
    onActivity: (() => void) | null = null
    private settle!: () => void
    private env: Env | null = null
    private spoken = 0

    constructor(
        readonly agentId: string,
        private readonly script: readonly string[],
        private readonly prompts: string[],
    ) {
        super()
        this.done = new Promise<unknown>((resolve) => {
            this.settle = () => resolve(null)
        })
    }

    start(environment: Env): void {
        this.env = environment
    }

    sendUserMessage(text: string): void {
        this.prompts.push(text)
        const reply = this.script[this.spoken]
        if (reply === undefined || this.env === null) return
        this.spoken += 1
        this.env.deliverSemanticEvent(
            this as unknown as Participant,
            AgentResult.create({
                agentId: this.agentId,
                terminalId: `${this.agentId}:turn-${this.spoken}`,
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: reply,
                usage: null,
                totalCostUsd: null,
                numTurns: null,
                durationMs: null,
            }),
        )
    }

    closeStdin(): void {}

    async abortAndWait(): Promise<boolean> {
        this.settle()
        return true
    }

    sessionEndDetail(): string {
        return "scripted participant ended"
    }
}

class ScriptedOutcomeLane implements InteractiveLaneAdapter {
    readonly backend = "fake-outcome"

    async grant(): Promise<LaneGrant> {
        return { close: async () => {} }
    }

    create(
        request: InteractiveParticipantRequest,
    ): InteractiveModelParticipant<unknown> {
        if (current === null) throw new Error("no outcome script is armed")
        return new ScriptedOutcomeParticipant(
            request.agentId,
            current.script,
            current.prompts,
        )
    }
}

let current: { script: readonly string[]; prompts: string[] } | null = null
registerLane("fake-outcome", () => new ScriptedOutcomeLane())

/**
 * Drives settleOutcome only: `maxResearchRounds: 0` sends the phase straight
 * to the outcome, so every prompt captured after the first is a repair prompt.
 */
async function runOutcomeSession(input: {
    script: readonly string[]
    validateOutcome: (raw: string) => void
    outcomeSchemaSummary?: string
    maxOutcomeRepairs?: number
}): Promise<{ prompts: string[]; result?: unknown; error?: unknown }> {
    const prompts: string[] = []
    current = { script: input.script, prompts }
    try {
        const result = await runArchitectBusSession({
            systemPrompt: "You are the architect for this engineering run.",
            userMessage: "Decide the shape of the change.",
            goal: "Decide the shape of the change.",
            cwd: process.cwd(),
            backend: "fake-outcome",
            environment: new AgenticEnvironment("architect-bus-outcome-test"),
            maxResearchRounds: 0,
            idleTimeoutMs: 30_000,
            validateOutcome: input.validateOutcome,
            ...(input.outcomeSchemaSummary !== undefined
                ? { outcomeSchemaSummary: input.outcomeSchemaSummary }
                : {}),
            ...(input.maxOutcomeRepairs !== undefined
                ? { maxOutcomeRepairs: input.maxOutcomeRepairs }
                : {}),
        })
        return { prompts, result }
    } catch (error) {
        return { prompts, error }
    } finally {
        current = null
    }
}

/** A validator that fails with the scripted defects of each attempt in turn. */
function scriptedValidator(
    attempts: readonly (readonly ContractDefect[] | null)[],
): (raw: string) => void {
    let call = 0
    return () => {
        const defects = attempts[call] ?? null
        call += 1
        if (defects !== null) throw new DefectiveOutcomeError(defects)
    }
}

const THREE_DEFECTS: readonly ContractDefect[] = [
    { path: "evidence[0]", message: "evidence[0].path must be a repository path" },
    { path: "evidence[2]", message: "evidence[2].fact must be 1-400 characters" },
    { path: "questions[1]", message: "questions[1].id must be unique" },
]

describe("architect bus session repair feedback", () => {
    // Pins O-015/O-034: one rejection carrying three defects produces ONE
    // repair round listing all three plus the schema, not three rounds.
    it("lists every defect of the attempt and restates the schema inline", async () => {
        const { prompts, result, error } = await runOutcomeSession({
            script: ["first attempt", "repaired attempt"],
            outcomeSchemaSummary: ARCHITECT_OUTCOME_SCHEMA_SUMMARY,
            validateOutcome: scriptedValidator([THREE_DEFECTS, null]),
        })

        assert.equal(error, undefined)
        assert.equal((result as { outcomeAttempts: number }).outcomeAttempts, 2)
        assert.equal(prompts.length, 2, "one instruction, then one repair round")
        assert.equal(
            prompts[1],
            "Your outcome was rejected. Fix every defect listed below in one reply.\n" +
                "\n" +
                "Defects (3):\n" +
                "- evidence[0]: evidence[0].path must be a repository path\n" +
                "- evidence[2]: evidence[2].fact must be 1-400 characters\n" +
                "- questions[1]: questions[1].id must be unique\n" +
                "\n" +
                "Expected schema:\n" +
                ARCHITECT_OUTCOME_SCHEMA_SUMMARY +
                "\n" +
                "\n" +
                "Reply with ONLY the corrected outcome. Change nothing that " +
                "was already valid, and do not restate this message.",
        )
    })

    // Pins O-035: without a summary the schema paragraph and its trailing
    // blank line vanish entirely — no empty "Expected schema:" heading.
    it("omits the schema paragraph when no summary is supplied", async () => {
        const twoDefects: readonly ContractDefect[] = [
            { path: "questions[0]", message: "questions[0].text is required" },
            { path: "questions[1]", message: "questions[1].text is required" },
        ]
        const { prompts, error } = await runOutcomeSession({
            script: ["first attempt", "repaired attempt"],
            validateOutcome: scriptedValidator([twoDefects, null]),
        })

        assert.equal(error, undefined)
        assert.equal(
            prompts[1],
            "Your outcome was rejected. Fix every defect listed below in one reply.\n" +
                "\n" +
                "Defects (2):\n" +
                "- questions[0]: questions[0].text is required\n" +
                "- questions[1]: questions[1].text is required\n" +
                "\n" +
                "Reply with ONLY the corrected outcome. Change nothing that " +
                "was already valid, and do not restate this message.",
        )
        assert.ok(!prompts[1]!.includes("Expected schema:"))
    })

    // Pins O-016/O-018/O-036: the exhaustion message carries the final
    // attempt's whole defect list plus the flavors earlier rounds resolved.
    it("reports the final defect list and the flavors repaired along the way", async () => {
        const questionsDefect: readonly ContractDefect[] = [
            { path: "questions[0]", message: "questions[0].id must be unique" },
        ]
        const evidenceDefects: readonly ContractDefect[] = [
            { path: "evidence[0]", message: "evidence[0].line must be an integer" },
            { path: "evidence[1]", message: "evidence[1].fact is required" },
        ]
        const { result, error } = await runOutcomeSession({
            script: ["attempt one", "attempt two", "attempt three"],
            validateOutcome: scriptedValidator([
                questionsDefect,
                questionsDefect,
                evidenceDefects,
            ]),
        })

        assert.equal(result, undefined, "no partial outcome is returned")
        assert.ok(error instanceof Error)
        assert.equal(
            (error as Error).message,
            "architect bus session: outcome rejected after 3 attempt(s): " +
                "evidence[0].line must be an integer; evidence[1].fact is required\n" +
                "final defects (2):\n" +
                "- evidence[0]: evidence[0].line must be an integer\n" +
                "- evidence[1]: evidence[1].fact is required\n" +
                "repaired defect flavors: questions",
        )
    })

    // Pins O-037: nothing was resolved when every attempt failed the same
    // way, and the line says so rather than being omitted.
    it("says none when no defect flavor was resolved before exhaustion", async () => {
        const evidenceDefects: readonly ContractDefect[] = [
            { path: "evidence[0]", message: "evidence[0].fact is required" },
            { path: "evidence[3]", message: "evidence[3].path must be relative" },
        ]
        const { error } = await runOutcomeSession({
            script: ["attempt one", "attempt two", "attempt three"],
            validateOutcome: scriptedValidator([
                evidenceDefects,
                evidenceDefects,
                evidenceDefects,
            ]),
        })

        assert.ok(error instanceof Error)
        assert.equal(
            (error as Error).message,
            "architect bus session: outcome rejected after 3 attempt(s): " +
                "evidence[0].fact is required; evidence[3].path must be relative\n" +
                "final defects (2):\n" +
                "- evidence[0]: evidence[0].fact is required\n" +
                "- evidence[3]: evidence[3].path must be relative\n" +
                "repaired defect flavors: none",
        )
    })

    // A validator that was never converted to defect carriage still works:
    // its single message keeps the exact exhaustion prefix it had before.
    it("keeps the exhaustion prefix for a validator that carries no defects", async () => {
        const { error } = await runOutcomeSession({
            script: ["attempt one", "attempt two"],
            maxOutcomeRepairs: 1,
            validateOutcome: () => {
                throw new Error("outcome must state ok:true")
            },
        })

        assert.ok(error instanceof Error)
        assert.ok(
            (error as Error).message.startsWith(
                "architect bus session: outcome rejected after 2 attempt(s): " +
                    "outcome must state ok:true\n",
            ),
        )
        assert.ok(
            (error as Error).message.endsWith(
                "final defects (1):\n" +
                    "- outcome must state ok:true\n" +
                    "repaired defect flavors: none",
            ),
        )
    })
})
