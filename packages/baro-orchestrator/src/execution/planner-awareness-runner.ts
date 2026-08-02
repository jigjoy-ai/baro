/**
 * Narrates execution back to a live bus planner.
 *
 * The subprocess planner learned nothing after publishing: stories ran,
 * merged, failed and verified while it planned blind. This runner turns the
 * execution events a planner would actually change its plan over — terminal
 * story results, merges and merge failures, blocked work, run verification —
 * into targeted messages on the planner's open stdin, so later fragments are
 * planned against what actually happened rather than what was hoped.
 */

import type { Participant, SemanticEvent } from "../runtime/mozaik.js"
import { BaseObserver } from "../runtime/mozaik.js"
import { AgentTargetedMessage } from "../events/collaboration.js"
import { StoryMerged, StoryMergeFailed } from "../events/integration.js"
import { WorkBlocked } from "../events/execution.js"
import { RunVerificationCompleted } from "../events/verification.js"
import { StoryResult } from "../semantic-events.js"

export interface PlannerAwarenessRunnerOptions {
    readonly runId: string
    /** The planner participant's bus agentId (see plannerBusAgentId). */
    readonly plannerAgentId: string
    /** Only this participant's merges are believed. */
    readonly integrationAuthority?: Participant
}

export class PlannerAwarenessRunner extends BaseObserver {
    constructor(private readonly opts: PlannerAwarenessRunnerOptions) {
        super()
    }

    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        // A throw here escapes the runtime uncaught (see overlap-awareness).
        try {
            const text = this.narrate(source, event)
            if (text) this.deliver(text)
        } catch (error) {
            process.stderr.write(
                `[planner-awareness] ignored a malformed event: ${error instanceof Error ? error.message : String(error)}\n`,
            )
        }
    }

    private narrate(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): string | null {
        if (StoryResult.is(event)) {
            const data = event.data
            if (data.runId !== undefined && data.runId !== this.opts.runId) {
                return null
            }
            if (data.suspension) return null
            if (data.success) return null // merges carry the good news
            return (
                `[execution] story ${data.storyId} FAILED after ` +
                `${data.attempts} attempt(s): ${data.error ?? "unknown error"}. ` +
                `Plan later fragments against this outcome.`
            )
        }
        if (StoryMerged.is(event)) {
            if (event.data.runId !== undefined && event.data.runId !== this.opts.runId) {
                return null
            }
            if (
                this.opts.integrationAuthority &&
                source !== this.opts.integrationAuthority
            ) {
                return null
            }
            return (
                `[execution] story ${event.data.storyId} completed and merged. ` +
                `Its declared write surface now exists in the repository.`
            )
        }
        if (StoryMergeFailed.is(event)) {
            if (event.data.runId !== undefined && event.data.runId !== this.opts.runId) {
                return null
            }
            return (
                `[execution] story ${event.data.storyId} finished but its merge ` +
                `FAILED: ${event.data.error}. Later stories that depend on its ` +
                `files may build on ground that is not there.`
            )
        }
        if (WorkBlocked.is(event)) {
            if (event.data.runId !== this.opts.runId) return null
            return (
                `[execution] story ${event.data.storyId} is blocked on ` +
                `${event.data.requiredStoryIds.join(", ")}: ${event.data.reason}`
            )
        }
        if (RunVerificationCompleted.is(event)) {
            if (event.data.runId !== this.opts.runId) return null
            const failed = event.data.commands.filter(
                (command) => command.status === "failed",
            )
            return failed.length === 0
                ? `[execution] run verification passed (${event.data.commands.length} command(s)).`
                : `[execution] run verification FAILED: ` +
                      failed
                          .map((command) => `${command.command}: ${command.tail ?? ""}`)
                          .join(" | ")
        }
        return null
    }

    private deliver(text: string): void {
        const event = AgentTargetedMessage.create({
            recipientId: this.opts.plannerAgentId,
            text,
            metadata: {
                source: "planner-awareness",
                runId: this.opts.runId,
            },
        })
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event as SemanticEvent<unknown>)
        }
    }
}
