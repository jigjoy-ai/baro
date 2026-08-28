import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ContractNote } from "../src/contract/contract-normalization.js"
import {
    ARCHITECT_DECISION_OUTCOME_JSON_SCHEMA,
    ARCHITECT_OUTCOME_JSON_SCHEMA,
    ARCHITECT_OUTCOME_SCHEMA_SUMMARY,
    MAX_ARCHITECT_DECISION_OUTCOME_BYTES,
    MAX_ARCHITECT_OUTCOME_BYTES,
    ArchitectOutcomeContractError,
    parseArchitectOutcome,
    wrapArchitectOutcome,
} from "../src/planning/domain/architect-outcome.js"
import { parseArchitectureDecisionDocument } from "../src/planning/domain/architecture-decision-document.js"
import {
    ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
    ARCHITECT_OUTCOME_SYSTEM_PROMPT,
} from "../src/planning/domain/architect-prompts.js"

const DECISION_DOCUMENT = `## Existing context
The repository uses a strict provider-neutral planning contract.

## ADR-001: Keep authority outside model output
**Status:** Accepted
**Context:** Provider text is untrusted.
**Decision:** Attach session and request correlation only after strict parsing.
**Consequences:** Malformed or foreign model output cannot advance planning.`

const OBLIGATION_DOCUMENT = `${DECISION_DOCUMENT}

## Semantic obligation contract

\`\`\`baro-obligations-v1
{"schemaVersion":1,"obligations":[{"id":"O-001","invariantIds":["G-A1"],"subject":"the provider-neutral planning boundary","scenario":"a non-trivial goal advances to planning","expectedOutcome":"the exact validated goal remains observable to downstream planning","evidence":["a focused outcome-contract test"]}]}
\`\`\``

const GOAL_ENVELOPE = {
    objective: "Keep authority outside model output.",
    acceptanceCriteria: ["The validated goal remains observable."],
    constraints: [],
    nonGoals: [],
    assumptions: [],
}

const TRIVIAL_DECISION_DOCUMENT = `## ADR-001: No cross-cutting decisions needed
**Status:** Accepted
**Context:** The requested change is one isolated repository edit.
**Decision:** This goal is trivial; no cross-cutting decisions are needed. Follow the
user's goal as stated and the conventions already in the repo.
**Consequences:** None of note.`

function ready() {
    return {
        schemaVersion: 1,
        kind: "ready",
        message: "Repository validation passed; planning may proceed.",
        questions: [],
        evidence: [],
        decisionDocument: DECISION_DOCUMENT,
    }
}

function needsInput() {
    return {
        schemaVersion: 1,
        kind: "needsInput",
        message: "One public compatibility choice remains unresolved.",
        questions: [{
            id: "wire-compat",
            text: "Must existing clients keep the current wire representation?",
            reason: "The repository contains both legacy and v2 serializers.",
        }],
        evidence: [{
            path: "src/protocol/serializer.ts",
            line: 42,
            fact: "The public serializer still emits the legacy field names.",
        }],
        decisionDocument: null,
    }
}

describe("ArchitectOutcomeV1", () => {
    it("accepts and deeply freezes both exact dispositions", () => {
        const acceptedReady = parseArchitectOutcome(JSON.stringify(ready()))
        assert.equal(acceptedReady.kind, "ready")
        assert.ok(Object.isFrozen(acceptedReady))
        assert.ok(Object.isFrozen(acceptedReady.questions))

        const acceptedNeedsInput = parseArchitectOutcome(JSON.stringify(needsInput()))
        assert.equal(acceptedNeedsInput.kind, "needsInput")
        assert.ok(Object.isFrozen(acceptedNeedsInput.questions[0]))
        assert.ok(Object.isFrozen(acceptedNeedsInput.evidence[0]))
        assert.throws(() => {
            ;(acceptedNeedsInput.evidence as unknown as unknown[]).push("forged")
        }, TypeError)

        // Non-schema providers and persisted v1 payloads remain compatible
        // with the original optional-reason parser contract.
        const withoutReason = needsInput()
        const question = withoutReason.questions[0] as { reason?: string }
        delete question.reason
        const acceptedWithoutReason = parseArchitectOutcome(
            JSON.stringify(withoutReason),
        )
        assert.equal("reason" in acceptedWithoutReason.questions[0]!, false)
    })

    it("keeps the shared prompt aligned with the strict native schema", () => {
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /reason field is required/)
        assert.doesNotMatch(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /optional reason/)
        assert.match(
            ARCHITECT_OUTCOME_SYSTEM_PROMPT,
            /direct read-only access to the selected\s+checkout/u,
        )
        assert.match(
            ARCHITECT_OUTCOME_SYSTEM_PROMPT,
            /not a\s+valid reason for needsInput/u,
        )
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /baro-obligations-v1/u)
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /directly callable/u)
    })

    it("makes a discovery goal cover every candidate, not the chosen one", () => {
        // Two audit runs each surveyed several suspects, named one, and left
        // the rest as prose — the planted defect went unexamined both times.
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /Enumerate every candidate/u)
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /selection by taste/u)
        assert.match(
            ARCHITECT_OUTCOME_SYSTEM_PROMPT,
            /demonstrated by a check that fails on the unfixed code, or dismissed/u,
        )
        // A dismissal must name a mechanism, and the fix stays scoped.
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /are not dismissals/u)
        assert.match(ARCHITECT_OUTCOME_SYSTEM_PROMPT, /Keep the FIX scoped/u)
    })

    it("uses a separate bounded ADR-only contract for phase one", () => {
        assert.match(
            ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
            /DECISION PHASE — ADRs ONLY/u,
        )
        assert.match(
            ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
            /Do not generate a semantic obligation/u,
        )
        assert.doesNotMatch(
            ARCHITECT_DECISION_OUTCOME_SYSTEM_PROMPT,
            /SEMANTIC OBLIGATION APPENDIX — REQUIRED/u,
        )

        // Located by shape, not position: phase one also offers a structured
        // decisions array, so the string branch is no longer necessarily first.
        const stringBranch = (schema: { anyOf: Array<{ type?: string }> }) =>
            schema.anyOf.find(({ type }) => type === "string") as {
                maxLength?: number
                pattern?: string
            }
        const decisionDocumentSchema = stringBranch(
            ARCHITECT_DECISION_OUTCOME_JSON_SCHEMA.properties.decisionDocument,
        )
        const completeDocumentSchema = stringBranch(
            ARCHITECT_OUTCOME_JSON_SCHEMA.properties.decisionDocument,
        )
        assert.equal(
            decisionDocumentSchema.maxLength,
            MAX_ARCHITECT_DECISION_OUTCOME_BYTES,
        )
        assert.equal("pattern" in decisionDocumentSchema, false)
        assert.match(completeDocumentSchema.pattern ?? "", /baro-obligations-v1/u)

        // Phase one accepts the decisions themselves; the complete contract
        // still takes only the finished document.
        const stated = ARCHITECT_DECISION_OUTCOME_JSON_SCHEMA
            .properties.decisionDocument.anyOf.find(
                ({ type }: { type?: string }) => type === "object",
            )
        assert.ok(stated, "phase one must let the Architect state its decisions")
        assert.deepEqual(stated.required, ["existingContext", "decisions"])
        assert.deepEqual(stated.properties.decisions.items.required, [
            "title",
            "context",
            "decision",
            "consequences",
        ])
        assert.equal(
            ARCHITECT_OUTCOME_JSON_SCHEMA.properties.decisionDocument.anyOf.some(
                ({ type }: { type?: string }) => type === "object",
            ),
            false,
        )

        assert.equal(
            parseArchitectOutcome(JSON.stringify(ready()), {
                decisionOnly: true,
            }).kind,
            "ready",
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT,
            }), {
                decisionOnly: true,
            }),
            /decision-only.*obligation marker/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(ready()), {
                decisionOnly: true,
                requireObligations: true,
            }),
            /cannot both be enabled/u,
        )

        const oversizedDecision = JSON.stringify({
            ...ready(),
            decisionDocument: `${DECISION_DOCUMENT}\n${"x".repeat(
                MAX_ARCHITECT_DECISION_OUTCOME_BYTES,
            )}`,
        })
        assert.ok(
            Buffer.byteLength(oversizedDecision, "utf8") < MAX_ARCHITECT_OUTCOME_BYTES,
        )
        assert.throws(
            () => parseArchitectOutcome(oversizedDecision, {
                decisionOnly: true,
            }),
            new RegExp(`bytes; limit is ${MAX_ARCHITECT_DECISION_OUTCOME_BYTES}`, "u"),
        )
        assert.equal(
            parseArchitectOutcome(oversizedDecision).kind,
            "ready",
            "the 48 KiB phase-one cap must not shrink the complete/default parser",
        )
    })

    it("requires contiguous accepted ADRs with complete fields outside code fences", () => {
        const secondAdrWithoutConsequences = `${DECISION_DOCUMENT}

## ADR-002: Keep the second boundary explicit
**Status:** Accepted
**Context:** A second caller has an independent compatibility boundary.
**Decision:** Preserve that caller through the same provider-neutral contract.`
        const internalGap = `${DECISION_DOCUMENT}

## ADR-003: Skip the second identifier
**Status:** Accepted
**Context:** This otherwise complete record has the wrong identifier.
**Decision:** Keep its contents irrelevant to the numbering check.
**Consequences:** The host must reject the missing ADR-002.`
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
                secondAdrWithoutConsequences,
                /ADR-002 requires a non-empty \*\*Consequences:\*\*/u,
            ],
            [
                "required field only inside a fence",
                DECISION_DOCUMENT.replace(
                    "**Context:** Provider text is untrusted.",
                    "```markdown\n**Context:** Fenced examples are not ADR fields.\n```",
                ),
                /ADR-001 requires a non-empty \*\*Context:\*\*/u,
            ],
        ]

        for (const [label, decisionDocument, expected] of invalidDocuments) {
            assert.throws(
                () => parseArchitectOutcome(JSON.stringify({
                    ...ready(),
                    decisionDocument,
                }), { decisionOnly: true }),
                expected,
                label,
            )
        }

        assert.equal(
            parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: `${DECISION_DOCUMENT}

\`\`\`markdown
## ADR-999: This fenced example is not a decision
**Status:** Rejected
\`\`\``,
            }), { decisionOnly: true }).kind,
            "ready",
        )
    })

    it("requires obligations for every outcome-mode document without breaking legacy parsing", () => {
        assert.equal(parseArchitectOutcome(JSON.stringify(ready())).kind, "ready")
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(ready()), {
                requireObligations: true,
            }),
            /requires a baro-obligations-v1 appendix/u,
        )
        assert.equal(
            parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT,
            }), {
                requireObligations: true,
                trustedGoalEnvelope: GOAL_ENVELOPE,
            }).kind,
            "ready",
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT.replace("G-A1", "G-A2"),
            }), {
                requireObligations: true,
                trustedGoalEnvelope: GOAL_ENVELOPE,
            }),
            /unknown GoalContract invariant.*G-A2/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: OBLIGATION_DOCUMENT,
            }), {
                requireObligations: true,
                trustedGoalEnvelope: {
                    ...GOAL_ENVELOPE,
                    constraints: ["Existing callers remain compatible."],
                },
            }),
            /does not refine.*G-C1/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: TRIVIAL_DECISION_DOCUMENT,
            }), {
                requireObligations: true,
                trustedGoalEnvelope: {
                    objective: "Preserve cancellation across every provider.",
                    acceptanceCriteria: [
                        "Every provider closes its stream.",
                        "Direct adapter callers observe cancellation.",
                        "Retry cleanup remains idempotent.",
                    ],
                    constraints: [
                        "Keep the public API compatible.",
                        "Do not centralize provider ownership.",
                    ],
                    nonGoals: [],
                    assumptions: [],
                },
            }),
            /requires a baro-obligations-v1 appendix/u,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                decisionDocument: `## Existing context
The second decision makes this a non-trivial architecture document.

${TRIVIAL_DECISION_DOCUMENT}

## ADR-002: Add a real cross-cutting design
**Status:** Accepted
**Context:** Multiple providers need a shared contract.
**Decision:** Introduce a provider-neutral boundary.
**Consequences:** Every provider must implement it.`,
            }), {
                requireObligations: true,
            }),
            /requires a baro-obligations-v1 appendix/u,
        )
    })

    it("rejects prose, unknown keys, discriminator violations and unsafe evidence", () => {
        assert.throws(
            () => parseArchitectOutcome(`\`\`\`json\n${JSON.stringify(ready())}\n\`\`\``),
            /not valid JSON/,
        )
        // A surplus key is now stripped (see the drift suite), so the exact-shape
        // check is pinned here by a MISSING required key instead.
        const withoutMessage: Record<string, unknown> = { ...ready() }
        delete withoutMessage.message
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(withoutMessage)),
            /exact v1 schema/,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...ready(),
                questions: [{ id: "q1", text: "forged" }],
            })),
            /ready.*empty questions and evidence/,
        )
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({
                ...needsInput(),
                decisionDocument: DECISION_DOCUMENT,
            })),
            /needsInput.*decisionDocument null/,
        )
        for (const path of ["/etc/passwd", "../secret", "src/../secret", "C:/secret", "src\\secret"]) {
            const value = needsInput()
            value.evidence[0]!.path = path
            assert.throws(
                () => parseArchitectOutcome(JSON.stringify(value)),
                /portable project-relative path/,
                path,
            )
        }
    })

    it("requires repository evidence for a needsInput disposition", () => {
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify({ ...needsInput(), evidence: [] })),
            /requires repository evidence/,
        )
    })

    it("enforces the UTF-8 wire ceiling before JSON parsing", () => {
        const oversized = "x".repeat(MAX_ARCHITECT_OUTCOME_BYTES + 1)
        assert.throws(
            () => parseArchitectOutcome(oversized),
            /bytes; limit/,
        )
    })

    it("attaches only trusted safe correlation outside the provider payload", () => {
        const outcome = parseArchitectOutcome(JSON.stringify(needsInput()))
        const transport = wrapArchitectOutcome(outcome, {
            sessionId: "session-1",
            goalRequestId: "goal-request-1",
            architectRequestId: "architect-request-1",
        })
        assert.deepEqual(Object.keys(transport), [
            "schemaVersion",
            "sessionId",
            "goalRequestId",
            "architectRequestId",
            "outcome",
        ])
        assert.equal("sessionId" in transport.outcome, false)
        assert.ok(Object.isFrozen(transport))
        assert.throws(
            () => wrapArchitectOutcome(outcome, {
                sessionId: "../foreign",
                goalRequestId: "goal-request-1",
                architectRequestId: "architect-request-1",
            }),
            ArchitectOutcomeContractError,
        )
    })
})

describe("ADR field values spanning lines", () => {
    // A live opus Architect burned 394s and then died on "requires a non-empty
    // **Decision:** field". The prompt demands an EXHAUSTIVE decision naming
    // exact paths, columns and endpoints — content that becomes a list under
    // the marker in any real markdown — so the shape was being rejected, not
    // the substance.
    const belowTheMarker = `## Existing context
The repository uses a strict provider-neutral planning contract.

## ADR-001: Keep authority outside model output
**Status:** Accepted
**Context:** Provider text is untrusted.
**Decision:**
- \`src/planning/domain/architect-outcome.ts\` owns parsing.
- Correlation is attached only after strict parsing.
**Consequences:** Malformed model output cannot advance planning.`

    it("accepts a value written beneath its marker", () => {
        const parsed = parseArchitectureDecisionDocument(belowTheMarker)
        const [adr] = parsed.decisions
        assert.match(adr!.decision, /architect-outcome\.ts` owns parsing\./u)
        assert.match(adr!.decision, /Correlation is attached only after/u)
        assert.equal(adr!.consequences, "Malformed model output cannot advance planning.")
    })

    it("still rejects a marker whose block is genuinely empty", () => {
        assert.throws(
            () => parseArchitectureDecisionDocument(
                belowTheMarker.replace(
                    "- `src/planning/domain/architect-outcome.ts` owns parsing.\n- Correlation is attached only after strict parsing.\n",
                    "",
                ),
            ),
            /ADR-001 has a \*\*Decision:\*\* marker but its block is empty/u,
        )
    })

    it("joins an inline opener with the lines continuing it", () => {
        // The old parser kept only the marker line, so a decision wrapped
        // across two lines reached the Planner cut off mid-sentence.
        const parsed = parseArchitectureDecisionDocument(
            belowTheMarker.replace("**Decision:**\n", "**Decision:** Parsing is owned by\n"),
        )
        assert.match(parsed.decisions[0]!.decision, /^Parsing is owned by\n/u)
        assert.match(parsed.decisions[0]!.decision, /Correlation is attached only after/u)
    })
})

describe("Architect states decisions, the host writes the document", () => {
    // Phase one died in production on "requires a non-empty **Decision:**"
    // because opus wrote the decision under the marker instead of after it.
    // Ids, numbering and field markers are the host's to produce; the model
    // supplies only what it actually decided.
    const existingContext = "The repository uses a strict planning contract."
    const drafts = [
        {
            title: "Keep authority outside model output",
            context: "Provider text is untrusted.",
            decision: "Attach correlation only after strict parsing.",
            consequences: "Malformed output cannot advance planning.",
        },
        {
            title: "Own the document shape",
            context: "Markdown structure is not a modelling decision.",
            decision: "Render ADR markup from the stated decisions.",
            consequences: "A sound decision cannot be rejected for punctuation.",
        },
    ]

    function structured() {
        return { ...ready(), decisionDocument: { existingContext, decisions: drafts } }
    }

    it("renders numbered ADRs the existing parser accepts unchanged", () => {
        const outcome = parseArchitectOutcome(JSON.stringify(structured()), {
            decisionOnly: true,
        })
        const parsed = parseArchitectureDecisionDocument(outcome.decisionDocument)

        assert.deepEqual(
            parsed.decisions.map(({ id, title, status }) => ({ id, title, status })),
            [
                { id: "ADR-001", title: drafts[0]!.title, status: "Accepted" },
                { id: "ADR-002", title: drafts[1]!.title, status: "Accepted" },
            ],
        )
        assert.equal(parsed.decisions[1]!.decision, drafts[1]!.decision)
    })

    it("strips surplus keys from stated decisions instead of refusing the outcome", () => {
        const annotated = structured()
        annotated.decisionDocument = {
            existingContext,
            rationale: "annotation the schema has no name for",
            decisions: [
                {
                    ...drafts[0]!,
                    invariants: ["G-A1"],
                    status: "Accepted",
                },
            ],
        } as never
        const outcome = parseArchitectOutcome(JSON.stringify(annotated), {
            decisionOnly: true,
        })
        const parsed = parseArchitectureDecisionDocument(outcome.decisionDocument)
        assert.equal(parsed.decisions.length, 1)
        assert.equal(parsed.decisions[0]!.title, drafts[0]!.title)
        assert.doesNotMatch(outcome.decisionDocument, /annotation the schema/)
    })

    it("keeps the verbatim document form working for backends that send one", () => {
        const outcome = parseArchitectOutcome(JSON.stringify(ready()), {
            decisionOnly: true,
        })
        assert.equal(outcome.decisionDocument, DECISION_DOCUMENT)
    })

    it("folds a wrapped title back onto its heading line", () => {
        const wrapped = structured()
        wrapped.decisionDocument = {
            existingContext,
            decisions: [{ ...drafts[0]!, title: "Keep authority\n   outside model output" }],
        }
        const outcome = parseArchitectOutcome(JSON.stringify(wrapped), {
            decisionOnly: true,
        })
        assert.match(outcome.decisionDocument, /## ADR-001: Keep authority outside model output\n/u)
    })

    it("rejects a decision that states nothing, and the complete contract still wants a document", () => {
        const empty = structured()
        empty.decisionDocument = {
            existingContext,
            decisions: [{ ...drafts[0]!, decision: "   " }],
        }
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(empty), { decisionOnly: true }),
            ArchitectOutcomeContractError,
        )
        // Only phase one authors decisions; the complete outcome carries the
        // finished document with its obligation appendix.
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(structured())),
            ArchitectOutcomeContractError,
        )
    })
})

describe("architect outcome drift normalization", () => {
    function notes() {
        const recorded: ContractNote[] = []
        return { recorded, sink: (note: ContractNote) => recorded.push(note) }
    }

    /** assert.throws discards the error; the defect list is what is asserted. */
    function rejection(run: () => unknown, label?: string): ArchitectOutcomeContractError {
        try {
            run()
        } catch (error) {
            assert.ok(error instanceof ArchitectOutcomeContractError, label)
            return error
        }
        assert.fail(label ?? "expected an ArchitectOutcomeContractError")
    }

    it("strips a model-supplied top-level key instead of refusing the outcome", () => {
        // Drift pinned: a surplus top-level field. Session authority still
        // cannot ride in on it — the key is dropped, never carried through.
        const { recorded, sink } = notes()
        const outcome = parseArchitectOutcome(
            JSON.stringify({ ...ready(), sessionId: "model-owned" }),
            {},
            sink,
        )
        assert.equal(outcome.kind, "ready")
        assert.equal("sessionId" in outcome, false)
        assert.deepEqual(recorded, [{
            severity: "warn",
            kind: "stripped_unexpected_field",
            path: "",
            detail: ': dropped unexpected field "sessionId"',
        }])
    })

    it("accepts drifted evidence and question records and reports what it changed", () => {
        // Drift pinned: one surplus field per record plus a casing variant of
        // an expected name, on a semantically complete needsInput outcome.
        const drifted = needsInput() as unknown as Record<string, unknown>
        drifted.questions = [{
            id: "wire-compat",
            text: "Must existing clients keep the current wire representation?",
            Reason: "The repository contains both legacy and v2 serializers.",
            priority: "high",
        }]
        drifted.evidence = [{
            path: "src/protocol/serializer.ts",
            Line: 42,
            fact: "The public serializer still emits the legacy field names.",
            confidence: 0.9,
        }]
        const raw = JSON.stringify(drifted)

        const { recorded, sink } = notes()
        const outcome = parseArchitectOutcome(raw, {}, sink)
        assert.equal(outcome.questions[0]!.reason, "The repository contains both legacy and v2 serializers.")
        assert.equal(outcome.evidence[0]!.line, 42)
        assert.deepEqual(
            recorded.map(({ kind, path, detail }) => ({ kind, path, detail })),
            [
                {
                    kind: "canonicalized_field",
                    path: "questions[0]",
                    detail: 'questions[0]: renamed field "Reason" to "reason"',
                },
                {
                    kind: "stripped_unexpected_field",
                    path: "questions[0]",
                    detail: 'questions[0]: dropped unexpected field "priority"',
                },
                {
                    kind: "canonicalized_field",
                    path: "evidence[0]",
                    detail: 'evidence[0]: renamed field "Line" to "line"',
                },
                {
                    kind: "stripped_unexpected_field",
                    path: "evidence[0]",
                    detail: 'evidence[0]: dropped unexpected field "confidence"',
                },
            ],
        )
        assert.ok(recorded.every((note) => note.severity === "warn"))

        // Notes are observation only: omitting the sink parses identically.
        assert.deepEqual(parseArchitectOutcome(raw), outcome)
    })

    it("reports every bad entry of one attempt, not just the first", () => {
        // Drift pinned: one repair round per mistake set. Two evidence entries
        // and one question entry are each invalid in the same reply.
        const broken = needsInput() as unknown as Record<string, unknown>
        broken.questions = [{ id: "not a safe id", text: "Which serializer stays?" }]
        broken.evidence = [
            { path: "../secret", line: 1, fact: "escaped the checkout" },
            { path: "src/protocol/serializer.ts", line: 0, fact: "line is out of range" },
        ]
        const error = rejection(() => parseArchitectOutcome(JSON.stringify(broken)))

        assert.deepEqual(error.defects, [
            {
                path: "questions[0]",
                message: "architect question id is not a safe correlation id",
            },
            {
                path: "evidence[0]",
                message: "architect evidence path must be a portable project-relative path",
            },
            {
                path: "evidence[1]",
                message: "architect evidence line must be null or a positive bounded integer",
            },
        ])
        assert.equal(error.message, error.defects.map((defect) => defect.message).join("; "))
    })

    it("keeps a single-defect rejection character-identical", () => {
        const broken = needsInput() as unknown as Record<string, unknown>
        broken.evidence = [{ path: "../secret", line: 1, fact: "escaped the checkout" }]
        const error = rejection(() => parseArchitectOutcome(JSON.stringify(broken)))
        assert.equal(
            error.message,
            "architect evidence path must be a portable project-relative path",
        )
    })

    it("treats an absent evidence or question element as missing content, never a hole", () => {
        // Drift pinned: skip-absent belongs to constraintPredicates alone. A
        // null here is content the outcome owed and did not supply.
        for (const [field, path] of [["evidence", "evidence[1]"], ["questions", "questions[1]"]] as const) {
            const holed = needsInput() as unknown as Record<string, unknown>
            holed[field] = [(holed[field] as unknown[])[0], null]
            const { recorded, sink } = notes()
            const error = rejection(
                () => parseArchitectOutcome(JSON.stringify(holed), {}, sink),
                field,
            )
            assert.deepEqual(error.defects.map((defect) => defect.path), [path])
            assert.equal(
                recorded.some((note) => note.kind === "skipped_absent_entry"),
                false,
                field,
            )
        }
    })

    it("rejects two fields that name the same thing rather than picking one", () => {
        const colliding = needsInput() as unknown as Record<string, unknown>
        colliding.evidence = [{
            path: "src/protocol/serializer.ts",
            line: 42,
            fact: "the legacy field names survive",
            Fact: "the legacy field names survive",
        }]
        const error = rejection(() => parseArchitectOutcome(JSON.stringify(colliding)))
        assert.deepEqual(error.defects, [{
            path: "evidence[0]",
            message: 'evidence[0]: fields "Fact" and "fact" both name "fact"',
        }])

        // A top-level collision is not an accumulation boundary, but it still
        // has to arrive as the class run-architect branches on.
        const topLevel = rejection(() => parseArchitectOutcome(JSON.stringify({
            ...ready(),
            decision_document: DECISION_DOCUMENT,
        })))
        assert.deepEqual(topLevel.defects, [{
            path: "",
            message: ': fields "decisionDocument" and "decision_document" both name "decisionDocument"',
        }])
    })

    it("keeps every bound exactly as strict after normalization", () => {
        // Normalization removes spelling and shape failures only: content that
        // was genuinely missing or out of bounds still rejects.
        const missingFact = needsInput() as unknown as Record<string, unknown>
        missingFact.evidence = [{ path: "src/protocol/serializer.ts", line: 42, note: "no fact" }]
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(missingFact)),
            /architect evidence shape is not exact/u,
        )

        const tooManyQuestions = needsInput() as unknown as Record<string, unknown>
        tooManyQuestions.questions = [0, 1, 2, 3].map((index) => ({
            id: `q-${index}`,
            text: "Which serializer stays?",
            commentary: "stripped, but the count bound is measured first",
        }))
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(tooManyQuestions)),
            /architect questions must contain at most 3 entries/u,
        )

        const tooMuchEvidence = needsInput() as unknown as Record<string, unknown>
        tooMuchEvidence.evidence = Array.from({ length: 17 }, (_, index) => ({
            path: `src/protocol/serializer-${index}.ts`,
            Line: index + 1,
            fact: `entry ${index}`,
        }))
        assert.throws(
            () => parseArchitectOutcome(JSON.stringify(tooMuchEvidence)),
            /architect evidence must contain at most 16 entries/u,
        )
    })

    it("restates the outcome schema inline for the repair prompt", () => {
        assert.ok(ARCHITECT_OUTCOME_SCHEMA_SUMMARY.length > 0)
        assert.match(
            ARCHITECT_OUTCOME_SCHEMA_SUMMARY,
            /\{"schemaVersion":1,"kind":"ready\|needsInput","message":"…","questions":\[\],"evidence":\[\],"decisionDocument":null,"constraintPredicates":\[\]\}/u,
        )
        assert.match(ARCHITECT_OUTCOME_SCHEMA_SUMMARY, /^questions\[i\]: /mu)
        assert.match(ARCHITECT_OUTCOME_SCHEMA_SUMMARY, /^evidence\[i\]: /mu)
        assert.match(ARCHITECT_OUTCOME_SCHEMA_SUMMARY, /^constraintPredicates\[i\]: /mu)
        // No new key reaches the envelope, so the Rust outcome check stays valid.
        assert.deepEqual(
            Object.keys(parseArchitectOutcome(JSON.stringify(ready()))).sort(),
            [
                "constraintPredicates",
                "decisionDocument",
                "evidence",
                "kind",
                "message",
                "questions",
                "schemaVersion",
            ],
        )
    })
})
