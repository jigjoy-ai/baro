import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ArchitectObligationOutputLimitError,
    ArchitectObligationSegmentError,
    MAX_ARCHITECT_OBLIGATION_REQUEST_BYTES,
    MAX_ARCHITECT_OBLIGATIONS_PER_SEGMENT,
    compileArchitectObligationSegments,
    type ArchitectObligationSegmentProgress,
    type ArchitectObligationSegmentRequest,
} from "../../src/planning/architect-obligation-segments.js"
import {
    ARCHITECTURE_OBLIGATION_FENCE,
    MAX_ARCHITECTURE_DECISION_DOCUMENT_BYTES,
    MAX_ARCHITECTURE_OBLIGATIONS,
    parseArchitectureObligationContract,
} from "../../src/planning/architecture-obligation-contract.js"

const DECISION_DOCUMENT = `## Existing context
The repository already has one shared boundary.

## ADR-001: Preserve that boundary
**Status:** Accepted
**Context:** Several callers depend on it.
**Decision:** Keep one compatible implementation contract.
**Consequences:** Every affected behavior needs focused evidence.`

function goalEnvelope(acceptance = 4, constraints = 3) {
    return {
        objective: "Preserve behavior at every affected boundary.",
        acceptanceCriteria: Array.from(
            { length: acceptance },
            (_, index) => `Acceptance behavior ${index + 1} is observable.`,
        ),
        constraints: Array.from(
            { length: constraints },
            (_, index) => `Compatibility constraint ${index + 1} remains true.`,
        ),
        nonGoals: [],
        assumptions: [],
    }
}

function responseFor(
    invariantIds: readonly string[],
    options: { reverse?: boolean; count?: number; adrIds?: readonly string[] } = {},
): string {
    const ids = options.reverse ? [...invariantIds].reverse() : [...invariantIds]
    const count = options.count ?? ids.length
    return JSON.stringify({
        schemaVersion: 1,
        obligations: Array.from({ length: count }, (_, index) => {
            const id = ids[index % ids.length]!
            return {
                adrIds: options.adrIds ?? ["ADR-001"],
                invariantIds: [id],
                subject: `subject ${id} ${index + 1}`,
                scenario: `scenario ${id} ${index + 1}`,
                expectedOutcome: `outcome ${id} ${index + 1}`,
                evidence: [`proof ${id} ${index + 1}`],
            }
        }),
    })
}

describe("segmented Architect obligation compiler", () => {
    it("batches A invariants before C invariants and assigns deterministic global ids", async () => {
        const requests: ArchitectObligationSegmentRequest[] = []
        const progress: ArchitectObligationSegmentProgress[] = []
        const result = await compileArchitectObligationSegments({
            decisionDocument: DECISION_DOCUMENT,
            goalEnvelope: goalEnvelope(),
            respond: async (request) => {
                requests.push(request)
                return responseFor(request.invariantIds, { reverse: true })
            },
            onProgress: (event) => progress.push(event),
        })

        assert.deepEqual(
            requests.map(({ batchId, attempt, invariantIds }) => ({
                batchId,
                attempt,
                invariantIds,
            })),
            [
                { batchId: "1", attempt: 1, invariantIds: ["G-A1", "G-A2", "G-A3"] },
                { batchId: "2", attempt: 1, invariantIds: ["G-A4", "G-C1", "G-C2"] },
                { batchId: "3", attempt: 1, invariantIds: ["G-C3"] },
            ],
        )
        assert.deepEqual(
            (result.contract.obligations[0] as unknown as Record<string, unknown>).adrIds,
            undefined,
        )
        const firstPayload = JSON.parse(requests[0]!.userPrompt) as {
            architectureDecisionIds: string[]
            maxObligations: number
        }
        assert.deepEqual(firstPayload.architectureDecisionIds, ["ADR-001"])
        assert.equal(
            firstPayload.maxObligations,
            MAX_ARCHITECT_OBLIGATIONS_PER_SEGMENT,
        )
        assert.deepEqual(
            result.contract.obligations.map(({ id, invariantIds }) => ({ id, invariantIds })),
            [
                { id: "O-001", invariantIds: ["G-A1"] },
                { id: "O-002", invariantIds: ["G-A2"] },
                { id: "O-003", invariantIds: ["G-A3"] },
                { id: "O-004", invariantIds: ["G-A4"] },
                { id: "O-005", invariantIds: ["G-C1"] },
                { id: "O-006", invariantIds: ["G-C2"] },
                { id: "O-007", invariantIds: ["G-C3"] },
            ],
        )
        assert.equal(
            result.decisionDocument.split(ARCHITECTURE_OBLIGATION_FENCE).length - 1,
            1,
        )
        assert.deepEqual(
            parseArchitectureObligationContract(result.decisionDocument),
            result.contract,
        )
        assert.deepEqual(
            progress.map(({ type, batchId }) => `${type}:${batchId}`),
            [
                "batch_started:1",
                "batch_completed:1",
                "batch_started:2",
                "batch_completed:2",
                "batch_started:3",
                "batch_completed:3",
            ],
        )
        assert.equal(JSON.stringify(progress).includes("userPrompt"), false)
        assert.equal(JSON.stringify(progress).includes("decisionDocument"), false)
    })

    it("sends only target invariant records without repeating unrelated goal context", async () => {
        const requests: ArchitectObligationSegmentRequest[] = []
        const envelope = {
            objective: "Keep the target behavior observable.",
            acceptanceCriteria: [
                "TARGET-A1 remains observable.",
                "TARGET-A2 remains observable.",
                "TARGET-A3 remains observable.",
                "NON-TARGET-A4 must not appear in batch one.",
            ],
            constraints: ["NON-TARGET-C1 must not appear in batch one."],
            nonGoals: ["NON-GOAL-SENTINEL must never be sent."],
            assumptions: ["ASSUMPTION-SENTINEL must never be sent."],
        }

        await compileArchitectObligationSegments({
            decisionDocument: DECISION_DOCUMENT,
            goalEnvelope: envelope,
            respond: async (request) => {
                requests.push(request)
                return responseFor(request.invariantIds)
            },
        })

        const payloads = requests.map(({ userPrompt }) => ({
            userPrompt,
            value: JSON.parse(userPrompt) as {
                objective: string
                targetInvariants: Array<{
                    id: string
                    kind: string
                    ordinal: number
                    text: string
                }>
                targetInvariantIds: string[]
            },
        }))
        const firstPrompt = payloads[0]!.userPrompt
        const firstPayload = payloads[0]!.value
        assert.equal(firstPayload.objective, envelope.objective)
        assert.deepEqual(firstPayload.targetInvariantIds, ["G-A1", "G-A2", "G-A3"])
        assert.deepEqual(
            firstPayload.targetInvariants.map(({ id, text }) => ({ id, text })),
            [
                { id: "G-A1", text: envelope.acceptanceCriteria[0] },
                { id: "G-A2", text: envelope.acceptanceCriteria[1] },
                { id: "G-A3", text: envelope.acceptanceCriteria[2] },
            ],
        )
        for (const { userPrompt, value } of payloads) {
            assert.deepEqual(
                value.targetInvariants.map(({ id }) => id),
                value.targetInvariantIds,
            )
            assert.equal(userPrompt.includes("NON-GOAL-SENTINEL"), false)
            assert.equal(userPrompt.includes("ASSUMPTION-SENTINEL"), false)
            assert.equal(Object.hasOwn(value, "goalContract"), false)
            assert.equal(Object.hasOwn(value, "nonGoals"), false)
            assert.equal(Object.hasOwn(value, "assumptions"), false)
        }
        for (const invariantText of [
            ...envelope.acceptanceCriteria,
            ...envelope.constraints,
        ]) {
            assert.equal(
                payloads.filter(({ userPrompt }) => userPrompt.includes(invariantText)).length,
                1,
            )
        }
        assert.equal(firstPrompt.includes("NON-TARGET-A4"), false)
        assert.equal(firstPrompt.includes("NON-TARGET-C1"), false)
    })

    it("fails closed before dispatch when a batch request exceeds its UTF-8 byte cap", async () => {
        const decisionPrefix = `${DECISION_DOCUMENT}\n`
        const decisionDocument = decisionPrefix + "x".repeat(
            MAX_ARCHITECTURE_DECISION_DOCUMENT_BYTES -
                Buffer.byteLength(decisionPrefix, "utf8"),
        )
        let calls = 0

        await assert.rejects(
            compileArchitectObligationSegments({
                decisionDocument,
                goalEnvelope: goalEnvelope(1, 0),
                respond: async () => {
                    calls += 1
                    return responseFor(["G-A1"])
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof ArchitectObligationSegmentError)
                assert.match(
                    error.message,
                    new RegExp(`request is \\d+ UTF-8 bytes; limit is ${MAX_ARCHITECT_OBLIGATION_REQUEST_BYTES}`),
                )
                return true
            },
        )
        assert.equal(calls, 0)
    })

    it("allows exactly one repair for strict JSON and prevents model-owned ids", async () => {
        const requests: ArchitectObligationSegmentRequest[] = []
        const progress: ArchitectObligationSegmentProgress[] = []
        const result = await compileArchitectObligationSegments({
            decisionDocument: DECISION_DOCUMENT,
            goalEnvelope: goalEnvelope(1, 0),
            respond: async (request) => {
                requests.push(request)
                if (request.attempt === 1) {
                    return JSON.stringify({
                        schemaVersion: 1,
                        obligations: [{
                            id: "O-999",
                            adrIds: ["ADR-001"],
                            invariantIds: ["G-A1"],
                            subject: "forged",
                            scenario: "forged",
                            expectedOutcome: "forged",
                            evidence: ["forged"],
                        }],
                    })
                }
                return responseFor(request.invariantIds)
            },
            onProgress: (event) => progress.push(event),
        })

        assert.deepEqual(requests.map(({ attempt }) => attempt), [1, 2])
        assert.match(requests[1]!.userPrompt, /exact shape without an id/u)
        assert.equal(result.contract.obligations[0]!.id, "O-001")
        assert.deepEqual(
            progress.map(({ type }) => type),
            ["batch_started", "batch_repair", "batch_started", "batch_completed"],
        )

        let calls = 0
        await assert.rejects(
            compileArchitectObligationSegments({
                decisionDocument: DECISION_DOCUMENT,
                goalEnvelope: goalEnvelope(1, 0),
                respond: async () => {
                    calls += 1
                    return "not-json"
                },
            }),
            /remained invalid after one repair/u,
        )
        assert.equal(calls, 2)
    })

    it("rejects foreign invariant ids and requires complete target coverage", async () => {
        for (const invalid of [
            responseFor(["G-A99"]),
            responseFor(["G-A1", "G-A2"]),
        ]) {
            let calls = 0
            await assert.rejects(
                compileArchitectObligationSegments({
                    decisionDocument: DECISION_DOCUMENT,
                    goalEnvelope: goalEnvelope(3, 0),
                    respond: async () => {
                        calls += 1
                        return invalid
                    },
                }),
                (error: unknown) => {
                    assert.ok(error instanceof ArchitectObligationSegmentError)
                    assert.match(
                        error.message,
                        /outside its target batch|does not cover target invariant/u,
                    )
                    return true
                },
            )
            assert.equal(calls, 2)
        }
    })

    it("requires every draft to be grounded in a parsed ADR heading", async () => {
        for (const adrIds of [[], ["ADR-999"]]) {
            let calls = 0
            await assert.rejects(
                compileArchitectObligationSegments({
                    decisionDocument: DECISION_DOCUMENT,
                    goalEnvelope: goalEnvelope(1, 0),
                    respond: async (request) => {
                        calls += 1
                        return responseFor(request.invariantIds, { adrIds })
                    },
                }),
                /invalid adrIds|unknown ADR/u,
            )
            assert.equal(calls, 2)
        }
    })

    it("rejects malformed ADR grounding before dispatch", async () => {
        const secondAdrWithoutDecision = `${DECISION_DOCUMENT}

## ADR-002: Preserve the second boundary
**Status:** Accepted
**Context:** A second boundary needs an independent decision.
**Consequences:** Its behavior remains compatible.`
        const internalGap = `${DECISION_DOCUMENT}

## ADR-003: Skip the second identifier
**Status:** Accepted
**Context:** This complete record intentionally leaves an id gap.
**Decision:** Its content must not make the numbering valid.
**Consequences:** The host rejects it before obligation dispatch.`
        const duplicateAdr = `${DECISION_DOCUMENT}

${DECISION_DOCUMENT.slice(DECISION_DOCUMENT.indexOf("## ADR-001"))}`
        const invalidDocuments: Array<[string, string, RegExp]> = [
            [
                "rejected status",
                DECISION_DOCUMENT.replace("**Status:** Accepted", "**Status:** Rejected"),
                /ADR-001.*Status.*Accepted/u,
            ],
            [
                "numbering gap",
                internalGap,
                /expected ADR-002 but found ADR-003/u,
            ],
            [
                "duplicate id",
                duplicateAdr,
                /duplicate ADR id ADR-001/u,
            ],
            [
                "missing field on one ADR",
                secondAdrWithoutDecision,
                /ADR-002 requires a non-empty \*\*Decision:\*\*/u,
            ],
        ]

        for (const [label, decisionDocument, expected] of invalidDocuments) {
            let calls = 0
            await assert.rejects(
                compileArchitectObligationSegments({
                    decisionDocument,
                    goalEnvelope: goalEnvelope(1, 0),
                    respond: async () => {
                        calls += 1
                        return responseFor(["G-A1"])
                    },
                }),
                expected,
                label,
            )
            assert.equal(calls, 0, label)
        }
    })

    it("bisects only output-limited batches and preserves deterministic order", async () => {
        const requests: ArchitectObligationSegmentRequest[] = []
        const progress: ArchitectObligationSegmentProgress[] = []
        const result = await compileArchitectObligationSegments({
            decisionDocument: DECISION_DOCUMENT,
            goalEnvelope: goalEnvelope(3, 0),
            respond: async (request) => {
                requests.push(request)
                if (request.invariantIds.length > 1) {
                    throw new ArchitectObligationOutputLimitError("max_output_tokens")
                }
                return responseFor(request.invariantIds)
            },
            onProgress: (event) => progress.push(event),
        })

        assert.deepEqual(
            requests.map(({ batchId, invariantIds, attempt }) => ({
                batchId,
                invariantIds,
                attempt,
            })),
            [
                { batchId: "1", invariantIds: ["G-A1", "G-A2", "G-A3"], attempt: 1 },
                { batchId: "1.1", invariantIds: ["G-A1"], attempt: 1 },
                { batchId: "1.2", invariantIds: ["G-A2", "G-A3"], attempt: 1 },
                { batchId: "1.2.1", invariantIds: ["G-A2"], attempt: 1 },
                { batchId: "1.2.2", invariantIds: ["G-A3"], attempt: 1 },
            ],
        )
        assert.deepEqual(
            result.contract.obligations.map(({ id, invariantIds }) => ({ id, invariantIds })),
            [
                { id: "O-001", invariantIds: ["G-A1"] },
                { id: "O-002", invariantIds: ["G-A2"] },
                { id: "O-003", invariantIds: ["G-A3"] },
            ],
        )
        assert.deepEqual(
            progress
                .filter(({ type }) => type === "batch_split")
                .map(({ batchId, childBatchIds }) => ({ batchId, childBatchIds })),
            [
                { batchId: "1", childBatchIds: ["1.1", "1.2"] },
                { batchId: "1.2", childBatchIds: ["1.2.1", "1.2.2"] },
            ],
        )
    })

    it("fails closed when a singleton remains output-limited", async () => {
        await assert.rejects(
            compileArchitectObligationSegments({
                decisionDocument: DECISION_DOCUMENT,
                goalEnvelope: goalEnvelope(1, 0),
                respond: async () => {
                    throw Object.assign(new Error("provider max output tokens exceeded"), {
                        code: "max_output_tokens",
                    })
                },
            }),
            /cannot be bisected further/u,
        )
    })

    it("uses fair per-batch quotas without exceeding the global v1 maximum", async () => {
        const result = await compileArchitectObligationSegments({
            decisionDocument: DECISION_DOCUMENT,
            goalEnvelope: goalEnvelope(32, 32),
            respond: async (request) => {
                const payload = JSON.parse(request.userPrompt) as {
                    maxObligations: number
                }
                return responseFor(request.invariantIds, {
                    count: payload.maxObligations,
                })
            },
        })

        assert.equal(result.contract.obligations.length, MAX_ARCHITECTURE_OBLIGATIONS)
        assert.equal(result.contract.obligations.at(-1)!.id, "O-128")
    })

    it("rejects an existing reserved fence before dispatch and honors pre-abort", async () => {
        let calls = 0
        await assert.rejects(
            compileArchitectObligationSegments({
                decisionDocument: `${DECISION_DOCUMENT}\n\n\`\`\`${ARCHITECTURE_OBLIGATION_FENCE}\n{}\n\`\`\``,
                goalEnvelope: goalEnvelope(1, 0),
                respond: async () => {
                    calls += 1
                    return responseFor(["G-A1"])
                },
            }),
            /already contains the reserved/u,
        )
        assert.equal(calls, 0)

        await assert.rejects(
            compileArchitectObligationSegments({
                decisionDocument:
                    `${DECISION_DOCUMENT}\n${"x".repeat(MAX_ARCHITECTURE_DECISION_DOCUMENT_BYTES)}`,
                goalEnvelope: goalEnvelope(1, 0),
                respond: async () => {
                    calls += 1
                    return responseFor(["G-A1"])
                },
            }),
            /bytes before obligation compilation; limit/u,
        )
        assert.equal(calls, 0)

        const controller = new AbortController()
        controller.abort(new Error("stop now"))
        await assert.rejects(
            compileArchitectObligationSegments({
                decisionDocument: DECISION_DOCUMENT,
                goalEnvelope: goalEnvelope(1, 0),
                signal: controller.signal,
                respond: async () => {
                    calls += 1
                    return responseFor(["G-A1"])
                },
            }),
            /stop now/u,
        )
        assert.equal(calls, 0)
    })
})
