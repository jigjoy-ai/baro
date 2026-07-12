import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    OpenAIStoryAgent,
    type OpenAIStoryAgentOptions,
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

        assert.equal(OpenAIStoryAgent.name, "OpenAIStoryAgent")
        assert.equal(options.runtimeReplanDecisionTimeoutMs, 1_000)
        assert.equal(correlation.baseGraphVersion, 2)
    })
})
