import { BaseObserver, type Participant, type SemanticEvent } from "@mozaik-ai/core"

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

export class LocalRepositoryAgent extends BaseObserver {
    private requestAuthority: Participant | null = null

    constructor(private readonly runId: string) {
        super()
    }

    setRequestAuthority(authority: Participant): void {
        if (this.requestAuthority && this.requestAuthority !== authority) {
            throw new Error("local repository request authority is already bound")
        }
        this.requestAuthority = authority
    }

    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (this.requestAuthority && source !== this.requestAuthority) return
        if (
            RunPreparationRequested.is(event) &&
            event.data.runId === this.runId
        ) {
            this.emit(RunPrepared.create({ runId: this.runId, baseSha: null }))
            return
        }
        if (
            StoryIntegrationRequested.is(event) &&
            event.data.runId === this.runId
        ) {
            this.emit(
                StoryMerged.create({
                    storyId: event.data.storyId,
                    mode: "shared-tree",
                    runId: event.data.runId,
                    leaseId: event.data.leaseId,
                }),
            )
            return
        }
        if (
            WorkspaceCleanupRequested.is(event) &&
            event.data.runId === this.runId
        ) {
            this.emit(
                WorkspaceCleanupCompleted.create({
                    runId: event.data.runId,
                    cleanupId: event.data.cleanupId,
                    storyId: event.data.storyId,
                    ...(event.data.leaseId !== undefined
                        ? { leaseId: event.data.leaseId }
                        : {}),
                    ...(event.data.generation !== undefined
                        ? { generation: event.data.generation }
                        : {}),
                }),
            )
            return
        }
        if (RunPushRequested.is(event) && event.data.runId === this.runId) {
            this.emit(RunPushed.create({ runId: this.runId, pushed: false }))
        }
    }

    private emit(event: SemanticEvent<unknown>): void {
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, event)
        }
    }
}
