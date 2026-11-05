import { type SemanticEvent } from "../runtime/mozaik.js"
import { BusMember } from "../runtime/coordination.js"

import {
    RunPreparationRequested,
    RunPrepared,
    RunPushRequested,
    RunPushed,
    StoryIntegrationRequested,
    StoryMerged,
    WorkspaceCleanupCompleted,
    WorkspaceCleanupRequested,
} from "../semantic-events.js"

export class LocalRepositoryAgent extends BusMember {
    private requestAuthority: BusMember | null = null

    constructor(private readonly runId: string) {
        super()
    }

    setRequestAuthority(authority: BusMember): void {
        if (this.requestAuthority && this.requestAuthority !== authority) {
            throw new Error("local repository request authority is already bound")
        }
        this.requestAuthority = authority
    }

    override onExternalEvent(
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): void {
        // This participant exists only on the collective path. Joining it
        // before Board construction must not create a fail-open startup
        // window in which an ambient bus participant can request integration,
        // cleanup, or run completion side effects.
        if (!this.requestAuthority || source !== this.requestAuthority) return
        if (
            RunPreparationRequested.is(event) &&
            event.payload.runId === this.runId
        ) {
            this.emit(RunPrepared.create({ runId: this.runId, baseSha: null }))
            return
        }
        if (
            StoryIntegrationRequested.is(event) &&
            event.payload.runId === this.runId
        ) {
            this.emit(
                StoryMerged.create({
                    storyId: event.payload.storyId,
                    mode: "shared-tree",
                    runId: event.payload.runId,
                    leaseId: event.payload.leaseId,
                }),
            )
            return
        }
        if (
            WorkspaceCleanupRequested.is(event) &&
            event.payload.runId === this.runId
        ) {
            this.emit(
                WorkspaceCleanupCompleted.create({
                    runId: event.payload.runId,
                    cleanupId: event.payload.cleanupId,
                    storyId: event.payload.storyId,
                    ...(event.payload.leaseId !== undefined
                        ? { leaseId: event.payload.leaseId }
                        : {}),
                    ...(event.payload.generation !== undefined
                        ? { generation: event.payload.generation }
                        : {}),
                }),
            )
            return
        }
        if (RunPushRequested.is(event) && event.payload.runId === this.runId) {
            this.emit(RunPushed.create({ runId: this.runId, pushed: false }))
        }
    }

    private emit(event: SemanticEvent<string, unknown>): void {
        for (const env of this.getBuses()) {
            env.publish(this, event)
        }
    }
}
