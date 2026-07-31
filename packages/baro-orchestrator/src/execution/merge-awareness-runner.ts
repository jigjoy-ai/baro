/**
 * Tells still-working agents what a sibling just landed.
 *
 * The gap this closes was measured: a story wrote two files, and died at
 * integration with "conflicts with already-merged work" against stories that
 * had merged while it worked. The bus carried every one of those merges. No
 * participant turned them into anything an agent could act on, so the agent
 * kept writing into ground that was no longer free and paid for it minutes
 * later at the merge.
 *
 * Writes are learned the same way Sentry learns them — from tool calls on the
 * bus — rather than from a git diff, because the point is to speak while the
 * work is still in flight, not to reconcile afterwards.
 */

import type { FunctionCallItem, Participant, SemanticEvent } from "../runtime/mozaik.js"
import { AgentTargetedMessage } from "../events/collaboration.js"
import { BaseObserver } from "../runtime/mozaik.js"
import { StoryMerged } from "../events/integration.js"
import { StoryResult } from "../semantic-events.js"
import {
    filePathFromToolCall,
    isFileMutationTool,
} from "../harness/tool-classification.js"
import { participantAgentId } from "../runtime/participant-identity.js"
import { noticesForLanding } from "./merge-awareness.js"

export interface MergeAwarenessRunnerOptions {
    readonly runId: string
    /** Only this participant's merges are believed. */
    readonly integrationAuthority?: Participant
}

export class MergeAwarenessRunner extends BaseObserver {
    /** agentId → files it has written so far. */
    private readonly writes = new Map<string, Set<string>>()
    /** Agents that have finished; they must not be told anything. */
    private readonly finished = new Set<string>()

    constructor(private readonly opts: MergeAwarenessRunnerOptions) {
        super()
    }

    override onExternalFunctionCall(source: Participant, item: FunctionCallItem): void {
        if (!isFileMutationTool(item.name)) return
        const agentId = participantAgentId(source)
        if (!agentId) return
        const path = filePathFromToolCall(item.args)
        if (!path) return
        const own = this.writes.get(agentId) ?? new Set<string>()
        own.add(path)
        this.writes.set(agentId, own)
    }

    override onExternalEvent(source: Participant, event: SemanticEvent<unknown>): void {
        // See overlap-awareness: a throw here escapes the runtime uncaught.
        try {
            this.react(source, event)
        } catch (error) {
            process.stderr.write(
                `[merge-awareness] ignored a malformed event: ${error instanceof Error ? error.message : String(error)}\n`,
            )
        }
    }

    private react(source: Participant, event: SemanticEvent<unknown>): void {
        if (StoryResult.is(event) && event.data.runId === this.opts.runId) {
            // A finished agent cannot act on news and may already be gone.
            this.finished.add(event.data.storyId)
            return
        }
        if (!StoryMerged.is(event)) return
        if (event.data.runId !== undefined && event.data.runId !== this.opts.runId) return
        // Integration is the one authority for "this landed". An unfenced
        // claim could otherwise make every agent drop work that never merged.
        if (this.opts.integrationAuthority && source !== this.opts.integrationAuthority) {
            return
        }
        this.announce(event.data.storyId)
    }

    private announce(storyId: string): void {
        const landedPaths = [...(this.writes.get(storyId) ?? [])]
        const audience = [...this.writes.keys()]
            .filter((agentId) => agentId !== storyId && !this.finished.has(agentId))
            .map((agentId) => ({
                agentId,
                writes: [...(this.writes.get(agentId) ?? [])],
            }))

        for (const notice of noticesForLanding({ storyId, paths: landedPaths }, audience)) {
            const event = AgentTargetedMessage.create({
                recipientId: notice.recipientId,
                text: notice.text,
                metadata: {
                    source: "merge-awareness",
                    runId: this.opts.runId,
                    landedStoryId: storyId,
                    collides: notice.collides,
                },
            })
            for (const environment of this.getEnvironments()) {
                environment.deliverSemanticEvent(this, event as SemanticEvent<unknown>)
            }
        }
    }
}
