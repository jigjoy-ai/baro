import { type SemanticEvent } from "../runtime/mozaik.js"
import { BusMember } from "../runtime/coordination.js"

import { RuntimeReplanApplied } from "../semantic-events.js"

interface CriticTargetStory {
    id: string
    acceptance?: readonly string[]
}

export function buildCriticTargets(
    stories: readonly CriticTargetStory[],
): Map<string, readonly string[]> {
    return new Map(
        stories
            .filter((story) => (story.acceptance?.length ?? 0) > 0)
            .map((story) => [story.id, criticCriteriaForStory(story)] as const),
    )
}

function criticCriteriaForStory(
    story: Pick<CriticTargetStory, "acceptance">,
): readonly string[] {
    return [...new Set(story.acceptance ?? [])]
}

export class CriticTargetRegistry extends BusMember {
    private runtimeReplanAuthority: BusMember | null = null
    private readonly seenRuntimeProposals = new Set<string>()
    private latestRuntimeGraphVersion = 0

    constructor(private readonly targets: Map<string, readonly string[]>) {
        super()
    }

    setRuntimeReplanAuthority(authority: BusMember): void {
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authority
        ) {
            throw new Error("critic target runtime replan authority is already bound")
        }
        this.runtimeReplanAuthority = authority
    }

    override onExternalEvent(
        source: BusMember,
        event: SemanticEvent<string, unknown>,
    ): void {
        if (RuntimeReplanApplied.is(event)) {
            if (source !== this.runtimeReplanAuthority) return
            if (
                this.seenRuntimeProposals.has(event.payload.proposalId) ||
                (event.payload.currentGraphVersion !== undefined &&
                    event.payload.graphVersion < event.payload.currentGraphVersion) ||
                event.payload.graphVersion <= this.latestRuntimeGraphVersion
            ) return
            this.seenRuntimeProposals.add(event.payload.proposalId)
            this.latestRuntimeGraphVersion =
                event.payload.currentGraphVersion ?? event.payload.graphVersion
            for (const storyId of event.payload.mutation.removedStoryIds) {
                this.targets.delete(storyId)
            }
            for (const story of event.payload.mutation.addedStories) {
                if (story.acceptance?.length) {
                    this.targets.set(story.id, criticCriteriaForStory(story))
                } else {
                    this.targets.delete(story.id)
                }
            }
        }
    }
}
