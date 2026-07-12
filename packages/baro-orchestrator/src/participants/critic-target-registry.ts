import { BaseObserver, type Participant, type SemanticEvent } from "@mozaik-ai/core"

import { Replan, RuntimeReplanApplied } from "../semantic-events.js"

export class CriticTargetRegistry extends BaseObserver {
    private runtimeReplanAuthority: Participant | null = null
    private readonly seenRuntimeProposals = new Set<string>()
    private latestRuntimeGraphVersion = 0

    constructor(private readonly targets: Map<string, readonly string[]>) {
        super()
    }

    setRuntimeReplanAuthority(authority: Participant): void {
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authority
        ) {
            throw new Error("critic target runtime replan authority is already bound")
        }
        this.runtimeReplanAuthority = authority
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (Replan.is(event)) {
            // Legacy Conductor keeps its existing raw-Replan projection. In
            // collective mode the Board's persisted Applied is authoritative.
            if (this.runtimeReplanAuthority) return
            for (const story of event.data.addedStories) {
                if (story.acceptance?.length) {
                    this.targets.set(story.id, [...story.acceptance])
                }
            }
            return
        }
        if (RuntimeReplanApplied.is(event)) {
            if (
                this.runtimeReplanAuthority &&
                _source !== this.runtimeReplanAuthority
            ) return
            if (
                this.seenRuntimeProposals.has(event.data.proposalId) ||
                (event.data.currentGraphVersion !== undefined &&
                    event.data.graphVersion < event.data.currentGraphVersion) ||
                event.data.graphVersion <= this.latestRuntimeGraphVersion
            ) return
            this.seenRuntimeProposals.add(event.data.proposalId)
            this.latestRuntimeGraphVersion =
                event.data.currentGraphVersion ?? event.data.graphVersion
            for (const storyId of event.data.mutation.removedStoryIds) {
                this.targets.delete(storyId)
            }
            for (const story of event.data.mutation.addedStories) {
                if (story.acceptance?.length) {
                    this.targets.set(story.id, [...story.acceptance])
                } else {
                    this.targets.delete(story.id)
                }
            }
        }
    }
}
