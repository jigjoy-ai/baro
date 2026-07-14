import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { SemanticEvent } from "@mozaik-ai/core"

import { CollectiveBoard } from "../../src/participants/collective-board.js"
import { conversationDelegationProposalId } from "../../src/participants/conversation-delegation.js"
import type { PrdFile } from "../../src/prd.js"
import {
    ConductorState,
    ConversationDelegationProposed,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    RunPrepared,
    RunStartRequest,
    WorkContextProvided,
    WorkContextRequested,
    WorkLeaseGranted,
    WorkOffered,
    type ConversationDelegationProposedData,
} from "../../src/semantic-events.js"
import {
    joinWithCapture,
    source,
    type CapturedEnvironment,
    withTempDir,
} from "./helpers.js"

describe("CollectiveBoard conversational delegation", () => {
    it("source-binds an add-only proposal, persists it, and offers it without granting a lease", async () => {
        await withTempDir("conversation-delegation-board-", async (dir) => {
            const runId = "run-conversation-delegation"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(initialPrd(), null, 2) + "\n")

            const dialogue = source("dialogue")
            const impersonator = source("dialogue")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
                maxDynamicStories: 1,
            })
            board.setConversationAuthority(dialogue)
            // Rebinding to the same concrete participant is idempotent; an
            // equal-looking object must never replace its authority.
            board.setConversationAuthority(dialogue)
            assert.throws(
                () => board.setConversationAuthority(impersonator),
                /already bound/,
            )
            const env = joinWithCapture(board)
            await startBoard(env, runId)

            const proposal = conversationProposal(runId, "delegation-1", 1)
            env.deliverSemanticEvent(impersonator, proposal)
            await board.idle()
            assert.equal(env.events.filter(RuntimeReplanApplied.is).length, 0)
            assert.equal(env.events.filter(RuntimeReplanRejected.is).length, 0)

            env.deliverSemanticEvent(dialogue, proposal)
            const applied = await waitFor(env.events, RuntimeReplanApplied.is)
            assert.equal(applied.data.sourceStoryId, "@conversation")
            assert.equal(
                applied.data.leaseId,
                `conversation:${proposal.data.proposalId}`,
            )
            assert.equal(applied.data.generation, 0)
            assert.deepEqual(applied.data.mutation.removedStoryIds, [])
            assert.deepEqual(applied.data.mutation.modifiedDeps, {})
            assert.equal(applied.data.mutation.addedStories[0]?.retries, 1)
            assert.equal(applied.data.mutation.addedStories[0]?.model, undefined)

            const persisted = readPrd(prdPath)
            const delegated = persisted.userStories.find((story) => story.id === "S2")
            assert.ok(delegated)
            assert.equal(delegated.retries, 1)
            assert.equal(delegated.model, undefined)
            assert.equal(persisted.runtimeGraph?.dynamicStories, 1)

            const contexts = await waitForCount(
                env.events,
                WorkContextRequested.is,
                2,
            )
            const delegatedContext = contexts.find(
                (event) => event.data.storyId === "S2",
            )
            assert.ok(delegatedContext)
            env.deliverSemanticEvent(
                source("context"),
                WorkContextProvided.create({
                    runId,
                    requestId: delegatedContext.data.requestId,
                    storyId: "S2",
                    context: null,
                }),
            )
            const offer = await waitFor(env.events, WorkOffered.is)
            assert.equal(offer.data.request.storyId, "S2")
            assert.equal(offer.data.request.graphVersion, 2)
            assert.equal(
                env.events.filter(WorkLeaseGranted.is).length,
                0,
                "only Broker may turn the Board offer into a lease",
            )

            // Durable idempotency replays the decision but never schedules or
            // persists the delegated story a second time.
            env.deliverSemanticEvent(dialogue, proposal)
            await waitForCount(env.events, RuntimeReplanApplied.is, 2)
            assert.equal(readPrd(prdPath).userStories.filter((s) => s.id === "S2").length, 1)
            assert.equal(env.events.filter(WorkContextRequested.is).length, 2)

            env.deliverSemanticEvent(
                dialogue,
                ConversationDelegationProposed.create({
                    ...proposal.data,
                    reason: "same id, different content",
                }),
            )
            let rejected = await waitFor(env.events, RuntimeReplanRejected.is)
            assert.equal(rejected.data.code, "proposal_id_conflict")

            env.deliverSemanticEvent(
                dialogue,
                conversationProposal(runId, "stale-delegation", 1),
            )
            rejected = (await waitForCount(
                env.events,
                RuntimeReplanRejected.is,
                2,
            ))[1]!
            assert.equal(rejected.data.code, "stale_graph_version")

            env.deliverSemanticEvent(
                dialogue,
                conversationProposal(runId, "over-dynamic-limit", 2, "S3"),
            )
            rejected = (await waitForCount(
                env.events,
                RuntimeReplanRejected.is,
                3,
            ))[2]!
            assert.equal(rejected.data.code, "dynamic_story_limit")
            assert.deepEqual(readPrd(prdPath).userStories.map((story) => story.id), [
                "S1",
                "S2",
            ])
        })
    })

    it("rejects broadened control fields and over-wide scope at the Board boundary", async () => {
        await withTempDir("conversation-delegation-narrow-", async (dir) => {
            const runId = "run-conversation-narrow"
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, JSON.stringify(initialPrd(), null, 2) + "\n")
            const dialogue = source("dialogue")
            const board = new CollectiveBoard({
                runId,
                prdPath,
                cwd: dir,
                timeoutSecs: 60,
            })
            board.setConversationAuthority(dialogue)
            const env = joinWithCapture(board)
            await startBoard(env, runId)

            const base = conversationProposal(runId, "narrow-proposal", 1).data
            const hostile = {
                ...base,
                removedStoryIds: ["S1"],
                modifiedDeps: { S1: ["S2"] },
                addedStories: base.addedStories.map((story) => ({
                    ...story,
                    priority: -2_147_483_648,
                    retries: 99,
                    model: "expensive-provider:model",
                    route: "attacker-route",
                })),
            } as ConversationDelegationProposedData
            env.deliverSemanticEvent(
                dialogue,
                ConversationDelegationProposed.create(hostile),
            )
            await board.idle()
            assert.equal(env.events.filter(RuntimeReplanApplied.is).length, 0)
            assert.match(
                env.events.filter(ConductorState.is).at(-1)?.data.detail ?? "",
                /malformed conversation proposal/,
            )

            const tooWideMessageId = "message-too-wide"
            env.deliverSemanticEvent(
                dialogue,
                ConversationDelegationProposed.create({
                    ...base,
                    messageId: tooWideMessageId,
                    proposalId: conversationDelegationProposalId(
                        runId,
                        tooWideMessageId,
                    ),
                    addedStories: ["S2", "S3", "S4"].map((storyId) => ({
                        id: storyId,
                        title: `Implement ${storyId}`,
                        description: `Implement ${storyId}.`,
                        dependsOn: [],
                        acceptance: [`${storyId} works`],
                        tests: ["npm test"],
                    })),
                }),
            )
            await board.idle()
            assert.equal(env.events.filter(RuntimeReplanApplied.is).length, 0)
            assert.deepEqual(readPrd(prdPath).userStories.map((story) => story.id), [
                "S1",
            ])
        })
    })
})

function conversationProposal(
    runId: string,
    proposalId: string,
    baseGraphVersion: number,
    storyId = "S2",
) {
    const messageId = `message-${proposalId}`
    return ConversationDelegationProposed.create({
        runId,
        messageId,
        proposalId: conversationDelegationProposalId(runId, messageId),
        agentId: "dialogue",
        baseGraphVersion,
        reason: `delegate ${storyId}`,
        addedStories: [{
            id: storyId,
            title: `Implement ${storyId}`,
            description: `Implement the dynamically delegated ${storyId} scope.`,
            dependsOn: [],
            acceptance: [`${storyId} is implemented`],
            tests: ["npm test"],
        }],
    })
}

function initialPrd(): PrdFile {
    return {
        project: "conversation delegation",
        branchName: "baro/conversation-delegation",
        description: "Exercise source-bound conversational work proposals.",
        userStories: [{
            id: "S1",
            priority: 1,
            title: "Initial story",
            description: "Keep one story active while Dialogue proposes another.",
            dependsOn: [],
            retries: 1,
            acceptance: ["S1 works"],
            tests: ["npm test"],
            passes: false,
            completedAt: null,
            durationSecs: null,
            model: "standard",
        }],
    }
}

async function startBoard(
    env: CapturedEnvironment,
    runId: string,
): Promise<void> {
    env.deliverSemanticEvent(
        source("operator"),
        RunStartRequest.create({ reason: "test" }),
    )
    env.deliverSemanticEvent(
        source("repository"),
        RunPrepared.create({ runId, baseSha: null }),
    )
    await waitFor(env.events, WorkContextRequested.is)
}

function readPrd(path: string): PrdFile {
    return JSON.parse(readFileSync(path, "utf8")) as PrdFile
}

async function waitFor<T extends SemanticEvent<unknown>>(
    events: SemanticEvent<unknown>[],
    guard: (event: SemanticEvent<unknown>) => event is T,
): Promise<T> {
    return (await waitForCount(events, guard, 1))[0]!
}

async function waitForCount<T extends SemanticEvent<unknown>>(
    events: SemanticEvent<unknown>[],
    guard: (event: SemanticEvent<unknown>) => event is T,
    count: number,
): Promise<T[]> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        const matches = events.filter(guard)
        if (matches.length >= count) return matches
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
    }
    assert.fail(`timed out waiting for ${count} events`)
}
