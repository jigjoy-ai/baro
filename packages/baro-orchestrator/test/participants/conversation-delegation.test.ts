import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    conversationDelegationProposalId,
    parseConversationDelegation,
    toRuntimeReplanProposal,
    validateConversationDelegationProposal,
} from "../../src/participants/conversation-delegation.js"
import type { ConversationDelegationProposedData } from "../../src/semantic-events.js"

describe("conversation delegation", () => {
    it("derives a deterministic bounded proposal id from the run and message", () => {
        const first = conversationDelegationProposalId("run-1", "message-1")
        assert.equal(
            first,
            conversationDelegationProposalId("run-1", "message-1"),
        )
        assert.notEqual(
            first,
            conversationDelegationProposalId("run-1", "message-2"),
        )
        assert.match(first, /^conversation:[a-f0-9]{64}$/)
        assert.ok(first.length < 256)
    })

    it("parses one strict, bounded, add-only atomic proposal", () => {
        assert.deepEqual(
            parseConversationDelegation({
                reason: "  A compatibility adapter is required.  ",
                stories: [
                    {
                        id: " S2 ",
                        title: " Compatibility adapter ",
                        description: " Support both wire formats. ",
                        depends_on: [" S1 "],
                        acceptance: [" Both formats are accepted. "],
                        tests: [" npm test -- compatibility "],
                    },
                ],
            }),
            {
                reason: "A compatibility adapter is required.",
                addedStories: [
                    {
                        id: "S2",
                        title: "Compatibility adapter",
                        description: "Support both wire formats.",
                        dependsOn: ["S1"],
                        acceptance: ["Both formats are accepted."],
                        tests: ["npm test -- compatibility"],
                    },
                ],
            },
        )

        assert.equal(parseConversationDelegation(null), null)
        assert.equal(
            parseConversationDelegation({
                reason: "attempt to choose a route",
                stories: [story("S2")],
                model: "expensive-model",
            }),
            null,
        )
        assert.equal(
            parseConversationDelegation({
                reason: "too much scope",
                stories: [story("S2"), story("S3"), story("S4")],
            }),
            null,
        )
        assert.equal(
            parseConversationDelegation({
                reason: "rewire existing work",
                stories: [story("S2")],
                modifiedDeps: { S1: ["S2"] },
            }),
            null,
        )
        assert.equal(
            parseConversationDelegation({
                reason: "duplicate scope",
                stories: [story("S2"), story("S2")],
            }),
            null,
        )
    })

    it("maps to deterministic worker-accounted runtime correlation without route authority", () => {
        const data: ConversationDelegationProposedData = {
            runId: "run-1",
            messageId: "message-1",
            proposalId: "conversation:proposal-1",
            agentId: "dialogue",
            baseGraphVersion: 4,
            reason: "Add the two implementation slices.",
            addedStories: [
                delegatedStory("S2", ["S1"]),
                delegatedStory("S3", ["S2"]),
            ],
        }

        const proposal = toRuntimeReplanProposal(data, 200)
        assert.deepEqual(proposal, {
            runId: "run-1",
            proposalId: "conversation:proposal-1",
            sourceStoryId: "@conversation",
            leaseId: "conversation:conversation:proposal-1",
            generation: 0,
            baseGraphVersion: 4,
            reason: "Add the two implementation slices.",
            mutation: {
                addedStories: [
                    {
                        ...delegatedStory("S2", ["S1"]),
                        priority: 200,
                        retries: 1,
                    },
                    {
                        ...delegatedStory("S3", ["S2"]),
                        priority: 201,
                        retries: 1,
                    },
                ],
                removedStoryIds: [],
                modifiedDeps: {},
            },
        })
        assert.equal("model" in proposal.mutation.addedStories[0]!, false)
    })

    it("revalidates exact deterministic scope at the Board boundary", () => {
        const messageId = "message-1"
        const proposal = {
            runId: "run-1",
            messageId,
            proposalId: conversationDelegationProposalId("run-1", messageId),
            agentId: "dialogue",
            baseGraphVersion: 1,
            reason: "Add bounded implementation work.",
            addedStories: [delegatedStory("S2", ["S1"])],
        }
        assert.deepEqual(validateConversationDelegationProposal(proposal), {
            ok: true,
            proposal,
        })
        assert.equal(
            validateConversationDelegationProposal({
                ...proposal,
                proposalId: "conversation:forged",
            }).ok,
            false,
        )
        assert.equal(
            validateConversationDelegationProposal({
                ...proposal,
                addedStories: [
                    delegatedStory("S2", []),
                    delegatedStory("S3", []),
                    delegatedStory("S4", []),
                ],
            }).ok,
            false,
        )
        assert.equal(
            validateConversationDelegationProposal({
                ...proposal,
                addedStories: [{
                    ...delegatedStory("S2", []),
                    model: "attacker:model",
                }],
            }).ok,
            false,
        )
    })
})

function story(id: string) {
    return {
        id,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        depends_on: [],
        acceptance: [`${id} works.`],
        tests: ["npm test"],
    }
}

function delegatedStory(id: string, dependsOn: string[]) {
    return {
        id,
        title: `Story ${id}`,
        description: `Implement ${id}.`,
        dependsOn,
        acceptance: [`${id} works.`],
        tests: ["npm test"],
    }
}
