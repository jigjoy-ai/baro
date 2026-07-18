import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { LocalRepositoryAgent } from "../../src/participants/local-repository-agent.js"
import {
    RunPreparationRequested,
    RunPrepared,
    RunPushRequested,
    RunPushed,
    StoryIntegrationRequested,
    StoryMerged,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

describe("LocalRepositoryAgent", () => {
    it("fails closed before its Board authority is bound", () => {
        const runId = "run-local-repository-unbound"
        const repository = new LocalRepositoryAgent(runId)
        const env = joinWithCapture(repository)

        env.deliverSemanticEvent(
            source("board"),
            RunPreparationRequested.create({ runId }),
        )

        assert.equal(env.events.filter(RunPrepared.is).length, 0)
    })

    it("accepts collective repository requests only from the bound Board", () => {
        const runId = "run-local-repository-authority"
        const board = source("board")
        const observer = source("observer")
        const repository = new LocalRepositoryAgent(runId)
        repository.setRequestAuthority(board)
        const env = joinWithCapture(repository)

        const preparation = RunPreparationRequested.create({ runId })
        env.deliverSemanticEvent(observer, preparation)
        assert.equal(env.events.filter(RunPrepared.is).length, 0)
        env.deliverSemanticEvent(board, preparation)
        assert.equal(env.events.filter(RunPrepared.is).length, 1)

        const integration = StoryIntegrationRequested.create({
            runId,
            leaseId: "lease-1",
            storyId: "S1",
            attempts: 1,
            durationSecs: 1,
        })
        env.deliverSemanticEvent(observer, integration)
        assert.equal(env.events.filter(StoryMerged.is).length, 0)
        env.deliverSemanticEvent(board, integration)
        assert.equal(env.events.filter(StoryMerged.is).length, 1)

        const cleanup = WorkspaceCleanupRequested.create({
            runId,
            cleanupId: "cleanup-1",
            storyId: "S1",
            leaseId: "lease-1",
            generation: 1,
        })
        env.deliverSemanticEvent(observer, cleanup)
        assert.equal(env.events.filter(WorkspaceCleanupCompleted.is).length, 0)
        env.deliverSemanticEvent(board, cleanup)
        assert.equal(env.events.filter(WorkspaceCleanupCompleted.is).length, 1)

        const push = RunPushRequested.create({ runId })
        env.deliverSemanticEvent(observer, push)
        assert.equal(env.events.filter(RunPushed.is).length, 0)
        env.deliverSemanticEvent(board, push)
        assert.equal(env.events.filter(RunPushed.is).length, 1)
    })
})
