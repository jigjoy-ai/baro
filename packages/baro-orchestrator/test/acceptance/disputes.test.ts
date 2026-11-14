import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import { parseVerdictJson } from "../../src/acceptance/critic-verdict.js"
import {
    DisputeLedger,
    parseDisputes,
    resolveAppeals,
} from "../../src/acceptance/disputes.js"
import { OneShotCritic } from "../../src/harness/one-shot/critic.js"
import { AgentResult, Critique } from "../../src/semantic-events.js"
import { joinWithCapture, source } from "../execution/helpers.js"

const CRITERIA = [
    "[O-001]; Subject: participantAgentId; Required evidence: a unit check",
    "[O-002]; Subject: test/ is untouched",
    "typecheck passes",
]

describe("parseDisputes", () => {
    it("binds a dispute to the story's criterion by ID, number or quote, and drops the rest", () => {
        const text = [
            "Done, with two objections.",
            "DISPUTE: [O-001]",
            "because: it contradicts [O-002]; inline node -e is refused by the shell (Command 4).",
            "DISPUTE: criterion 3",
            "because: Command 7 shows tsc exit 0.",
            "DISPUTE: [O-999]",
            "because: not one of mine",
            "DISPUTE: [O-002]",
        ].join("\n")

        assert.deepEqual(parseDisputes(text, CRITERIA), [
            { criterion: CRITERIA[0], because: "it contradicts [O-002]; inline node -e is refused by the shell (Command 4)." },
            { criterion: "typecheck passes", because: "Command 7 shows tsc exit 0." },
        ])
        assert.deepEqual(parseDisputes("no disputes here", CRITERIA), [])
    })
})

describe("resolveAppeals", () => {
    const dispute = { criterion: CRITERIA[0]!, because: "contradicts [O-002]" }
    const failing = {
        status: "evaluated" as const,
        verdict: "fail" as const,
        reasoning: "No unit check was captured.",
        violatedCriteria: [CRITERIA[0]!],
    }

    it("hears no appeal the first time a dispute is held, and decides it the second time", async () => {
        const ledger = new DisputeLedger()
        const prompts: string[] = []
        const judge = async (prompt: string) => {
            prompts.push(prompt)
            return { status: "evaluated" as const, verdict: "pass" as const, reasoning: "It contradicts O-002.", violatedCriteria: [] }
        }
        const input = { disputes: [dispute], ledger, agentId: "S1", prompts: ["## Acceptance criteria\n1. " + CRITERIA[0]], judge }

        const first = await resolveAppeals({ ...input, evaluation: failing })
        assert.equal(first, failing)
        assert.equal(prompts.length, 0)

        const second = await resolveAppeals({ ...input, evaluation: failing })
        assert.equal(second.verdict, "pass")
        assert.deepEqual(second.violatedCriteria, [])
        assert.match(second.reasoning, /Appeal on \[O-001\]: decided for the story\. It contradicts O-002\./)
        assert.match(prompts[0]!, /^## Appeal\n/)
        assert.match(prompts[0]!, /First reviewer: No unit check was captured\./)
        assert.match(prompts[0]!, /Story: contradicts \[O-002\]/)

        // A ruled criterion is never appealed again.
        await resolveAppeals({ ...input, evaluation: failing })
        assert.equal(prompts.length, 1)
    })

    it("keeps the finding when the judge upholds it, and other violations either way", async () => {
        const ledger = new DisputeLedger()
        ledger.recordUpheld("S1", dispute.criterion)
        const result = await resolveAppeals({
            evaluation: { ...failing, violatedCriteria: [CRITERIA[0]!, "typecheck passes"] },
            disputes: [dispute],
            ledger,
            agentId: "S1",
            prompts: ["p"],
            judge: async () => ({ status: "evaluated", verdict: "fail", reasoning: "A unit check fits in test/.", violatedCriteria: [CRITERIA[0]!] }),
        })
        assert.equal(result.verdict, "fail")
        assert.deepEqual(result.violatedCriteria, [CRITERIA[0], "typecheck passes"])
        assert.match(result.reasoning, /Appeal on \[O-001\]: the finding stands\./)
    })

    it("asks again later when the judge could not decide", async () => {
        const ledger = new DisputeLedger()
        ledger.recordUpheld("S1", dispute.criterion)
        let calls = 0
        const judge = async () => {
            calls += 1
            return calls === 1
                ? { status: "inconclusive" as const, verdict: "fail" as const, reasoning: "LLM call failed", violatedCriteria: [] }
                : { status: "evaluated" as const, verdict: "pass" as const, reasoning: "ok", violatedCriteria: [] }
        }
        const input = { disputes: [dispute], ledger, agentId: "S1", prompts: ["p"], judge }
        assert.equal((await resolveAppeals({ ...input, evaluation: failing })).verdict, "fail")
        assert.equal((await resolveAppeals({ ...input, evaluation: failing })).verdict, "pass")
    })
})

class ScriptedCritic extends OneShotCritic {
    readonly prompts: string[] = []

    constructor(private readonly reply: (prompt: string) => string) {
        super({ targets: new Map([["agent-a", CRITERIA]]), maxEmissionsPerAgent: 3 }, {
            backend: "pi",
            defaultModelLabel: "scripted",
            errorLabel: "Critic Scripted",
        }, undefined)
    }

    protected override async invoke(prompt: string): Promise<string> {
        this.prompts.push(prompt)
        return this.reply(prompt)
    }
}

describe("a story disputing a Critic verdict", () => {
    it("is answered by the Critic, then decided by an independent judge in the same evaluation", async () => {
        const critic = new ScriptedCritic((prompt) =>
            prompt.startsWith("## Appeal")
                ? JSON.stringify({ verdict: "pass", reasoning: "O-001 and O-002 cannot both hold.", violated_criteria: [] })
                : JSON.stringify({ verdict: "fail", reasoning: "Upheld: no unit check was captured.", violated_criteria: [CRITERIA[0]] }),
        )
        const env = joinWithCapture(critic)
        const turn = (text: string) =>
            critic.onExternalEvent(source("runner"), AgentResult.create({
                agentId: "agent-a",
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: text,
                usage: null,
                totalCostUsd: null,
                numTurns: null,
                durationMs: null,
            }))
        const disputing = "DISPUTE: [O-001]\nbecause: it contradicts [O-002]."

        await turn("first candidate")
        await turn(disputing)
        await turn(disputing)
        await critic.idle()

        const verdicts = env.events.filter(Critique.is).map((event) => event.payload.verdict)
        assert.deepEqual(verdicts, ["fail", "fail", "pass"])
        assert.match(critic.prompts[1]!, /## Disputes raised by the story\n[\s\S]*Story: it contradicts \[O-002\]\./)
        assert.equal(critic.prompts.filter((prompt) => prompt.startsWith("## Appeal")).length, 1)
    })
})

describe("parseVerdictJson", () => {
    it("keeps an escape JSON does not know as a literal backslash", () => {
        const text = '{"verdict":"fail","reasoning":"see src\\_x and it\\\'s \\"quoted\\" \\\\ ok","violated_criteria":[]}'
        assert.deepEqual(parseVerdictJson(text), {
            verdict: "fail",
            reasoning: "see src\\_x and it\\'s \"quoted\" \\ ok",
            violated_criteria: [],
        })
    })
})
