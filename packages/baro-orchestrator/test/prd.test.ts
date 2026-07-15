import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
    BARO_COAUTHOR_TRAILER,
    applyReplanWithEffectiveDelta,
    buildDefaultStoryPrompt,
    markStoryPassed,
    normalizePrd,
    savePrdAtomic,
    type PrdFile,
    type PrdStory,
} from "../src/prd.js"
import { runtimeAppliedProposalFingerprint } from "../src/runtime/runtime-replan-fingerprint.js"
import type { RuntimeReplanAppliedData } from "../src/semantic-events.js"
import { withTempDir } from "./participants/helpers.js"

function story(overrides: Partial<PrdStory> = {}): PrdStory {
    return {
        id: "S1",
        priority: 1,
        title: "Test PRD helpers",
        description: "Add focused tests for PRD helper behavior.",
        dependsOn: [],
        retries: 2,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: undefined,
        ...overrides,
    }
}

function appliedDecision(
    overrides: Partial<RuntimeReplanAppliedData> = {},
): RuntimeReplanAppliedData {
    return {
        runId: "run-runtime",
        proposalId: "proposal-1",
        sourceStoryId: "S1",
        leaseId: "lease-1",
        generation: 1,
        baseGraphVersion: 3,
        previousGraphVersion: 3,
        graphVersion: 4,
        currentGraphVersion: 4,
        reason: "discovered required work",
        mutation: {
            addedStories: [],
            removedStoryIds: [],
            modifiedDeps: { S2: ["S1"] },
        },
        ...overrides,
    }
}

describe("normalizePrd", () => {
    it("applies defaults and filters story string arrays", () => {
        const prd = normalizePrd(
            {
                userStories: [
                    {
                        id: "S1",
                        priority: 7,
                        title: "Story one",
                        description: "Has mixed array values.",
                        dependsOn: ["S0", 1, "S00"],
                        retries: 30.9,
                        acceptance: ["works", false, "ships"],
                        tests: ["npm test", null, "cargo test"],
                        passes: "yes",
                        completedAt: 42,
                        durationSecs: "fast",
                        model: 5,
                    },
                    {},
                ],
            } as unknown as Partial<PrdFile>,
            "prd.json",
        )

        assert.equal(prd.project, "")
        assert.equal(prd.branchName, "")
        assert.equal(prd.description, "")
        assert.deepEqual(prd.userStories[0], {
            id: "S1",
            priority: 7,
            title: "Story one",
            description: "Has mixed array values.",
            dependsOn: ["S0", "S00"],
            retries: 5,
            acceptance: ["works", "ships"],
            tests: ["npm test", "cargo test"],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: undefined,
        })
        assert.deepEqual(prd.userStories[1], {
            id: "S2",
            priority: 0,
            title: "",
            description: "",
            dependsOn: [],
            retries: 2,
            acceptance: [],
            tests: [],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: undefined,
        })
    })

    it("canonicalizes doubled baro/baro branch prefixes", () => {
        const prd = normalizePrd(
            {
                branchName: "baro/baro/baro/feature-prd-tests",
                userStories: [],
            },
            "prd.json",
        )

        assert.equal(prd.branchName, "baro/feature-prd-tests")
    })

    it("preserves decision and execution metadata", () => {
        const executionMode = {
            mode: "parallel" as const,
            reason: "independent stories",
            confidence: 0.9,
            maxStories: 4,
            parallelism: 2,
            source: "llm",
        }
        const prd = normalizePrd(
            {
                decisionDocument: "Use the existing PRD schema.",
                executionMode,
                userStories: [],
            },
            "prd.json",
        )

        assert.equal(prd.decisionDocument, "Use the existing PRD schema.")
        assert.deepEqual(prd.executionMode, executionMode)
    })

    it("normalizes durable runtime graph metadata and drops malformed decisions", () => {
        const validApplied = appliedDecision()
        const runtimeGraph = {
            runId: "run-runtime",
            version: 4,
            dynamicStories: 2,
            appliedDecisions: [
                { fingerprint: 7, applied: {} },
                {
                    fingerprint: "malformed-mutation",
                    applied: {
                        runId: "run-runtime",
                        proposalId: "malformed",
                        sourceStoryId: "S1",
                        leaseId: "lease-1",
                        generation: 1,
                        baseGraphVersion: 2,
                        previousGraphVersion: 2,
                        graphVersion: 3,
                        reason: "bad ledger entry",
                        mutation: {},
                    },
                },
                {
                    fingerprint:
                        runtimeAppliedProposalFingerprint(validApplied),
                    applied: validApplied,
                },
            ],
        }

        const prd = normalizePrd(
            { userStories: [], runtimeGraph } as unknown as Partial<PrdFile>,
            "prd.json",
        )

        assert.equal(prd.runtimeGraph?.version, 4)
        assert.equal(prd.runtimeGraph?.dynamicStories, 2)
        assert.equal(prd.runtimeGraph?.policyStories, 0)
        assert.equal(prd.runtimeGraph?.appliedDecisions.length, 1)
        assert.equal(
            prd.runtimeGraph?.appliedDecisions[0]?.applied.proposalId,
            "proposal-1",
        )
        runtimeGraph.appliedDecisions[2]!.applied.mutation.modifiedDeps.S2.push(
            "later-mutation",
        )
        assert.deepEqual(
            prd.runtimeGraph?.appliedDecisions[0]?.applied.mutation.modifiedDeps,
            { S2: ["S1"] },
        )
    })

    it("preserves a valid progressive-planning latch and rejects a corrupt ledger", () => {
        const planning = {
            schemaVersion: 1 as const,
            runId: "run-runtime",
            planningId: "planning-1",
            status: "open" as const,
            nextOrdinal: 2,
            admittedStoryIds: ["S1"],
            fragments: [
                {
                    fragmentId: "fragment-1",
                    ordinal: 1,
                    fingerprint: "sha256:fragment-1",
                    storyIds: ["S1"],
                    graphVersion: 2,
                },
            ],
        }
        const normalized = normalizePrd(
            {
                userStories: [story()],
                runtimeGraph: {
                    runId: "run-runtime",
                    version: 2,
                    dynamicStories: 0,
                    policyStories: 0,
                    appliedDecisions: [],
                    planning,
                },
            },
            "progressive-prd.json",
        )

        assert.deepEqual(normalized.runtimeGraph?.planning, planning)
        planning.fragments[0]!.storyIds.push("S2")
        assert.deepEqual(
            normalized.runtimeGraph?.planning?.fragments[0]?.storyIds,
            ["S1"],
        )

        assert.throws(
            () =>
                normalizePrd(
                    {
                        userStories: [],
                        runtimeGraph: {
                            runId: "run-runtime",
                            version: 2,
                            dynamicStories: 0,
                            policyStories: 0,
                            appliedDecisions: [],
                            planning: {
                                ...planning,
                                nextOrdinal: 3,
                            },
                        },
                    },
                    "corrupt-progressive-prd.json",
                ),
            /inconsistent progressive planning ledger/,
        )
    })

    it("drops fingerprint mismatches and every ambiguous duplicate proposal id", () => {
        const mismatched = appliedDecision({
            proposalId: "mismatched",
        })
        const duplicate = appliedDecision({
            proposalId: "duplicate",
            baseGraphVersion: 1,
            previousGraphVersion: 1,
            graphVersion: 2,
        })
        const unique = appliedDecision({
            proposalId: "unique",
            baseGraphVersion: 2,
            previousGraphVersion: 2,
            graphVersion: 3,
        })
        const duplicateRecord = {
            fingerprint: runtimeAppliedProposalFingerprint(duplicate),
            applied: duplicate,
        }

        const prd = normalizePrd(
            {
                userStories: [],
                runtimeGraph: {
                    runId: "run-runtime",
                    version: 4,
                    dynamicStories: 2,
                    appliedDecisions: [
                        { fingerprint: "wrong", applied: mismatched },
                        duplicateRecord,
                        structuredClone(duplicateRecord),
                        {
                            fingerprint:
                                runtimeAppliedProposalFingerprint(unique),
                            applied: unique,
                        },
                    ],
                },
            },
            "prd.json",
        )

        assert.deepEqual(
            prd.runtimeGraph?.appliedDecisions.map(
                (decision) => decision.applied.proposalId,
            ),
            ["unique"],
        )
    })
})

describe("savePrdAtomic", () => {
    it("replaces the complete snapshot without retaining its temporary file", async () => {
        await withTempDir("prd-atomic-", async (dir) => {
            const path = join(dir, "prd.json")
            writeFileSync(path, "old bytes\n")
            const value: PrdFile = {
                project: "atomic",
                branchName: "baro/atomic",
                description: "complete snapshot",
                userStories: [story()],
            }

            savePrdAtomic(path, value)

            assert.deepEqual(
                JSON.parse(readFileSync(path, "utf8")),
                JSON.parse(JSON.stringify(value)),
            )
            assert.deepEqual(readdirSync(dir), ["prd.json"])
        })
    })
})

describe("markStoryPassed", () => {
    it("returns an immutable PRD update for the matching story", () => {
        const prd = normalizePrd(
            {
                project: "baro",
                branchName: "baro/prd-tests",
                description: "Test PRD helpers.",
                userStories: [
                    story({ id: "S1", title: "First" }),
                    story({ id: "S2", title: "Second" }),
                ],
            },
            "prd.json",
        )
        const before = Date.now()

        const updated = markStoryPassed(prd, "S2", 12.5)
        const after = Date.now()

        assert.notEqual(updated, prd)
        assert.notEqual(updated.userStories, prd.userStories)
        assert.deepEqual(updated.userStories[0], prd.userStories[0])
        assert.deepEqual(prd.userStories[1], story({ id: "S2", title: "Second" }))
        assert.equal(updated.userStories[1].passes, true)
        assert.equal(updated.userStories[1].durationSecs, 12.5)
        assert.equal(typeof updated.userStories[1].completedAt, "string")
        const completedAt = Date.parse(updated.userStories[1].completedAt!)
        assert.ok(completedAt >= before)
        assert.ok(completedAt <= after)
    })
})

describe("applyReplanWithEffectiveDelta", () => {
    it("reports only persisted removals, additions, and dependency changes", () => {
        const passed = story({ id: "S1", passes: true })
        const existing = story({ id: "S2", dependsOn: ["S1"] })
        const prd: PrdFile = {
            project: "baro",
            branchName: "baro/effective-replan",
            description: "Test effective legacy replan deltas.",
            userStories: [passed, existing],
        }
        const duplicate = {
            id: "S2",
            priority: 1,
            title: "Duplicate",
            description: "Must be ignored.",
            dependsOn: [],
        }
        const addition = {
            id: "S3",
            priority: 2,
            title: "Actual addition",
            description: "Must be persisted.",
            dependsOn: ["S2"],
            acceptance: ["S3 exists"],
        }

        const result = applyReplanWithEffectiveDelta(prd, {
            source: "surgeon",
            reason: "mixed fresh and stale operations",
            removedStoryIds: ["S1", "S-missing"],
            addedStories: [duplicate, addition],
            modifiedDeps: {
                S2: [],
                "S-missing": ["S1"],
            },
        })

        assert.deepEqual(result.applied, {
            source: "surgeon",
            reason: "mixed fresh and stale operations",
            removedStoryIds: [],
            addedStories: [addition],
            modifiedDeps: { S2: [] },
        })
        assert.deepEqual(
            result.prd.userStories.map(({ id, dependsOn, passes }) => ({
                id,
                dependsOn,
                passes,
            })),
            [
                { id: "S1", dependsOn: [], passes: true },
                { id: "S2", dependsOn: [], passes: false },
                { id: "S3", dependsOn: ["S2"], passes: false },
            ],
        )
        assert.deepEqual(prd.userStories, [passed, existing])
    })
})

describe("buildDefaultStoryPrompt", () => {
    it("includes acceptance criteria, test commands, and coauthor trailer", () => {
        const prompt = buildDefaultStoryPrompt(
            story({
                id: "S7",
                title: "Prompt coverage",
                description: "Verify the default prompt content.",
                acceptance: ["Normalize PRD defaults", "Keep metadata"],
                tests: ["npm test -- prd.test.ts", "npm run build"],
            }),
        )

        assert.ok(prompt.includes("You are working on story S7: Prompt coverage"))
        assert.ok(
            prompt.includes(
                "ACCEPTANCE CRITERIA:\n1. Normalize PRD defaults\n2. Keep metadata",
            ),
        )
        assert.ok(
            prompt.includes("TEST COMMANDS:\n- npm test -- prd.test.ts\n- npm run build"),
        )
        assert.ok(prompt.includes(BARO_COAUTHOR_TRAILER))
    })
})
