import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createRuntimeReplanTool,
    parseRuntimeReplanArgs,
    runtimeReplanToolOutput,
    validGraphVersion,
} from "../../src/participants/runtime-replan-tool.js"

describe("runtime replan function tool", () => {
    it("publishes a closed strict schema with the launch graph version", async () => {
        const tool = createRuntimeReplanTool(12)

        assert.equal(tool.name, "propose_replan")
        assert.equal(tool.strict, true)
        assert.equal(tool.parameters.additionalProperties, false)
        assert.deepEqual(tool.parameters.required, [
            "baseGraphVersion",
            "reason",
            "addedStories",
            "removedStoryIds",
            "modifiedDeps",
        ])
        assert.equal(tool.parameters.properties.baseGraphVersion.default, 12)
        assert.equal(
            tool.parameters.properties.addedStories.items.additionalProperties,
            false,
        )
        assert.deepEqual(
            tool.parameters.properties.addedStories.items.required,
            [
                "id",
                "priority",
                "title",
                "description",
                "dependsOn",
                "acceptance",
                "tests",
            ],
        )
        assert.deepEqual(
            JSON.parse(String(await tool.invoke({}))),
            {
                ok: false,
                status: "invalid",
                code: "runtime_interception_required",
                reason: "propose_replan must be handled by OpenAIStoryAgent",
            },
        )
    })

    it("parses and normalizes the complete runtime mutation", () => {
        const parsed = parseRuntimeReplanArgs(
            JSON.stringify({
                baseGraphVersion: 3,
                reason: "  add the discovered migration  ",
                addedStories: [
                    {
                        id: "S2",
                        priority: 2,
                        title: "Migration",
                        description: "Add the prerequisite migration.",
                        dependsOn: ["S0"],
                        retries: 1,
                        acceptance: ["migration exists"],
                        tests: ["npm test"],
                        model: "gpt-5.4-mini",
                        goalInvariantIds: ["G-A1", "G-C1"],
                    },
                ],
                removedStoryIds: ["S-future"],
                modifiedDeps: { S1: ["S2"] },
            }),
        )

        assert.deepEqual(parsed, {
            ok: true,
            value: {
                baseGraphVersion: 3,
                reason: "add the discovered migration",
                mutation: {
                    addedStories: [
                        {
                            id: "S2",
                            priority: 2,
                            title: "Migration",
                            description: "Add the prerequisite migration.",
                            dependsOn: ["S0"],
                            retries: 1,
                            acceptance: ["migration exists"],
                            tests: ["npm test"],
                            model: "gpt-5.4-mini",
                            goalInvariantIds: ["G-A1", "G-C1"],
                        },
                    ],
                    removedStoryIds: ["S-future"],
                    modifiedDeps: { S1: ["S2"] },
                },
            },
        })
    })

    it("rejects malformed or open-ended payloads before they reach the bus", () => {
        const valid = {
            baseGraphVersion: 3,
            reason: "needed",
            addedStories: [],
            removedStoryIds: [],
            modifiedDeps: {},
        }
        const validStory = {
            id: "S2",
            priority: 1,
            title: "T",
            description: "D",
            dependsOn: [],
            acceptance: ["T works"],
            tests: ["npm test"],
        }
        const cases: Array<[unknown, RegExp]> = [
            ["not-json", /not valid JSON/],
            [{ ...valid, unexpected: true }, /unknown argument 'unexpected'/],
            [{ ...valid, baseGraphVersion: -1 }, /positive integer/],
            [{ ...valid, reason: "  " }, /non-empty string/],
            [{ ...valid, addedStories: {} }, /addedStories must be an array/],
            [
                {
                    ...valid,
                    addedStories: [
                        {
                            id: "S2",
                            priority: 1,
                            title: "T",
                            description: "D",
                            dependsOn: [],
                            surprise: true,
                        },
                    ],
                },
                /unknown field 'surprise'/,
            ],
            [
                {
                    ...valid,
                    addedStories: [
                        {
                            id: "S2",
                            priority: 1,
                            title: "T",
                            description: "D",
                            dependsOn: [],
                            retries: 0.5,
                        },
                    ],
                },
                /retries must be an integer between 0 and 5/,
            ],
            [
                {
                    ...valid,
                    addedStories: [{ ...validStory, acceptance: undefined }],
                },
                /acceptance must be a non-empty array of non-blank strings/,
            ],
            [
                { ...valid, addedStories: [{ ...validStory, acceptance: [] }] },
                /acceptance must be a non-empty array of non-blank strings/,
            ],
            [
                { ...valid, addedStories: [{ ...validStory, acceptance: [" "] }] },
                /acceptance must be a non-empty array of non-blank strings/,
            ],
            [
                {
                    ...valid,
                    addedStories: [{ ...validStory, tests: undefined }],
                },
                /tests must be a non-empty array of non-blank strings/,
            ],
            [
                { ...valid, addedStories: [{ ...validStory, tests: [] }] },
                /tests must be a non-empty array of non-blank strings/,
            ],
            [
                { ...valid, addedStories: [{ ...validStory, tests: ["\t"] }] },
                /tests must be a non-empty array of non-blank strings/,
            ],
            [
                {
                    ...valid,
                    addedStories: [{
                        ...validStory,
                        goalInvariantIds: ["G-A1", "G-A1"],
                    }],
                },
                /unique GoalContract invariant ids/,
            ],
            [
                {
                    ...valid,
                    addedStories: [{
                        ...validStory,
                        goalInvariantIds: ["not-an-invariant"],
                    }],
                },
                /unique GoalContract invariant ids/,
            ],
            [{ ...valid, removedStoryIds: [1] }, /array of strings/],
            [{ ...valid, modifiedDeps: { S1: [1] } }, /array of strings/],
        ]

        for (const [input, expected] of cases) {
            const raw = typeof input === "string" ? input : JSON.stringify(input)
            const parsed = parseRuntimeReplanArgs(raw)
            assert.equal(parsed.ok, false, raw)
            if (!parsed.ok) assert.match(parsed.error, expected)
        }
    })

    it("produces stable machine-readable outputs and validates graph versions", () => {
        assert.deepEqual(
            JSON.parse(
                runtimeReplanToolOutput("applied", {
                    proposalId: "proposal-1",
                    graphVersion: 4,
                }),
            ),
            {
                ok: true,
                status: "applied",
                proposalId: "proposal-1",
                graphVersion: 4,
            },
        )
        assert.deepEqual(
            JSON.parse(
                runtimeReplanToolOutput("rejected", {
                    code: "stale_graph_version",
                }),
            ),
            {
                ok: false,
                status: "rejected",
                code: "stale_graph_version",
            },
        )
        assert.equal(validGraphVersion(0), false)
        assert.equal(validGraphVersion(2), true)
        assert.equal(validGraphVersion(-1), false)
        assert.equal(validGraphVersion(1.5), false)
        assert.equal(validGraphVersion("2"), false)
    })
})
