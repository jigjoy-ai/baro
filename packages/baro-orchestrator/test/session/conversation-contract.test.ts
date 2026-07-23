import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ConversationContractError,
    goalEnvelopeFingerprint,
    parseConversationResponse,
    validateConversationResponse,
} from "../../src/session/conversation-contract.js"

const correlation = {
    sessionId: "session-1",
    requestId: "request-1",
}

describe("conversation wire contract", () => {
    it("accepts and freezes one exactly correlated ready GoalEnvelope", () => {
        const response = parseConversationResponse(
            JSON.stringify(readyWire()),
            correlation,
        )

        assert.equal(response.kind, "ready")
        assert.equal(response.sessionId, correlation.sessionId)
        assert.equal(response.requestId, correlation.requestId)
        assert.deepEqual(response.questions, [])
        assert.deepEqual(response.goalEnvelope, {
            objective: "Add session-first goal intake.",
            constraints: ["Do not let conversation choose model routes."],
            acceptanceCriteria: ["A clear goal reaches planning without another question."],
            nonGoals: ["Do not redesign the TUI in this slice."],
            assumptions: ["Collective execution remains opt-in."],
        })
        assert.equal(Object.isFrozen(response), true)
        assert.equal(Object.isFrozen(response.goalEnvelope), true)
        assert.equal(Object.isFrozen(response.goalEnvelope?.constraints), true)

        const first = goalEnvelopeFingerprint(response.goalEnvelope!)
        const second = goalEnvelopeFingerprint({ ...response.goalEnvelope! })
        assert.equal(first, second)
    })

    it("accepts strict clarification and informational answer shapes", () => {
        const clarify = validateConversationResponse(
            {
                schemaVersion: 1,
                ...correlation,
                kind: "clarify",
                message: "I need one decision before I can hand this off.",
                questions: [{
                    id: "q-api",
                    text: "May the public API change?",
                    reason: "That changes compatibility scope.",
                }],
                goalEnvelope: null,
            },
            correlation,
        )
        assert.equal(clarify.questions[0]?.id, "q-api")

        const answer = validateConversationResponse(
            {
                schemaVersion: 1,
                ...correlation,
                kind: "answer",
                message: "The run is currently verifying.",
                questions: [],
                goalEnvelope: null,
            },
            correlation,
        )
        assert.equal(answer.kind, "answer")
    })

    it("unwraps chat framing but fails closed on unknown keys, foreign correlation, and broadened control", () => {
        // Chat harnesses nondeterministically add prose/fence framing around
        // the requested object; the framed object still passes the exact
        // schema and correlation validation below.
        assert.equal(
            parseConversationResponse(
                `Here is the result: ${JSON.stringify(readyWire())}`,
                correlation,
            ).kind,
            readyWire().kind,
        )
        assert.equal(
            parseConversationResponse(
                "```json\n" + JSON.stringify(readyWire()) + "\n```",
                correlation,
            ).kind,
            readyWire().kind,
        )
        // Prose without any JSON object still fails closed.
        assert.throws(
            () => parseConversationResponse(
                "I cannot produce the requested object.",
                correlation,
            ),
            ConversationContractError,
        )
        assert.throws(
            () => validateConversationResponse(
                { ...readyWire(), route: "openai:cheap" },
                correlation,
            ),
            /exact v1 schema/,
        )
        assert.throws(
            () => validateConversationResponse(
                { ...readyWire(), requestId: "foreign-request" },
                correlation,
            ),
            /requestId correlation mismatch/,
        )
        assert.throws(
            () => validateConversationResponse(
                {
                    ...readyWire(),
                    goalEnvelope: {
                        ...readyWire().goalEnvelope,
                        model: "gpt-5.5",
                    },
                },
                correlation,
            ),
            /goalEnvelope shape is not exact/,
        )
    })

    it("enforces kind-specific nullability and bounded unique questions", () => {
        assert.throws(
            () => validateConversationResponse(
                { ...readyWire(), questions: [{ id: "q1", text: "Why?" }] },
                correlation,
            ),
            /ready response cannot contain/,
        )
        assert.throws(
            () => validateConversationResponse(
                {
                    schemaVersion: 1,
                    ...correlation,
                    kind: "clarify",
                    message: "Need input.",
                    questions: [],
                    goalEnvelope: null,
                },
                correlation,
            ),
            /requires at least one question/,
        )
        assert.throws(
            () => validateConversationResponse(
                {
                    schemaVersion: 1,
                    ...correlation,
                    kind: "clarify",
                    message: "Need input.",
                    questions: [
                        { id: "q1", text: "First?" },
                        { id: "q1", text: "Duplicate?" },
                    ],
                    goalEnvelope: null,
                },
                correlation,
            ),
            /ids must be unique/,
        )
    })

    it("rejects bidi controls in model-authored user-facing text", () => {
        const message = readyWire()
        message.message = "Safe prefix\u202Emoc.elpmaxe"
        assert.throws(
            () => validateConversationResponse(message, correlation),
            /unsafe/,
        )

        const objective = readyWire()
        objective.goalEnvelope.objective = "Safe goal\u2066spoof"
        assert.throws(
            () => validateConversationResponse(objective, correlation),
            /unsafe/,
        )

        assert.throws(
            () => validateConversationResponse({
                schemaVersion: 1,
                ...correlation,
                kind: "clarify",
                message: "Need input.",
                questions: [{ id: "q1", text: "Safe\u202Aquestion?" }],
                goalEnvelope: null,
            }, correlation),
            /unsafe/,
        )
    })
})

function readyWire() {
    return {
        schemaVersion: 1,
        ...correlation,
        kind: "ready",
        message: "This is clear; I am ready to hand it to planning.",
        questions: [],
        goalEnvelope: {
            objective: "Add session-first goal intake.",
            constraints: ["Do not let conversation choose model routes."],
            acceptanceCriteria: ["A clear goal reaches planning without another question."],
            nonGoals: ["Do not redesign the TUI in this slice."],
            assumptions: ["Collective execution remains opt-in."],
        },
    }
}
