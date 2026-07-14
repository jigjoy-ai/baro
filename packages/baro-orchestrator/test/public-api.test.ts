import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ConversationDelegationProposed,
    OpenAIStoryAgent,
    type OpenAIStoryAgentOptions,
    type ConversationDelegationProposedData,
    type RuntimeReplanCorrelationData,
} from "../src/main.js"

describe("public package API", () => {
    it("exports the native OpenAI story agent and runtime replan correlation", () => {
        const options: OpenAIStoryAgentOptions = {
            runtimeReplanDecisionTimeoutMs: 1_000,
        }
        const correlation: RuntimeReplanCorrelationData = {
            runId: "run-1",
            proposalId: "proposal-1",
            sourceStoryId: "S1",
            leaseId: "lease-1",
            generation: 1,
            baseGraphVersion: 2,
        }
        const delegation: ConversationDelegationProposedData = {
            runId: "run-1",
            messageId: "message-1",
            proposalId: "delegation-1",
            agentId: "dialogue",
            baseGraphVersion: 2,
            reason: "new implementation scope was discovered",
            addedStories: [{
                id: "S2",
                title: "Implement S2",
                description: "Implement the newly discovered scope.",
                dependsOn: ["S1"],
                acceptance: ["S2 works"],
                tests: ["npm test"],
            }],
        }

        assert.equal(OpenAIStoryAgent.name, "OpenAIStoryAgent")
        assert.equal(
            ConversationDelegationProposed.create(delegation).type,
            "conversation_delegation_proposed",
        )
        assert.equal(options.runtimeReplanDecisionTimeoutMs, 1_000)
        assert.equal(correlation.baseGraphVersion, 2)
    })
})
