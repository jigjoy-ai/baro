import { type SemanticEvent } from "../runtime/mozaik.js"
import { BusMember } from "../runtime/coordination.js"

import {
    Replan,
    ReplanApplied,
    RuntimeReplanApplied,
} from "../semantic-events.js"

interface CriticTargetStory {
    id: string
    acceptance?: readonly string[]
    goalInvariantIds?: readonly string[]
}

export function buildCriticTargets(
    stories: readonly CriticTargetStory[],
    goalInvariantText: ReadonlyMap<string, string> = new Map(),
): Map<string, readonly string[]> {
    return new Map(
        stories
            .filter((story) => (story.acceptance?.length ?? 0) > 0)
            .map((story) => [
                story.id,
                criticCriteriaForStory(story, goalInvariantText),
            ] as const),
    )
}

function criticCriteriaForStory(
    story: Pick<CriticTargetStory, "acceptance" | "goalInvariantIds">,
    goalInvariantText: ReadonlyMap<string, string>,
): readonly string[] {
    return [
        ...new Set([
            ...(story.acceptance ?? []),
            ...(story.goalInvariantIds ?? [])
                .map((id) => goalInvariantText.get(id))
                .filter((item): item is string => item !== undefined),
        ]),
    ]
}

export class CriticTargetRegistry extends BusMember {
    private legacyReplanAuthority: BusMember | null = null
    private runtimeReplanAuthority: BusMember | null = null
    private readonly seenRuntimeProposals = new Set<string>()
    private latestRuntimeGraphVersion = 0

    constructor(
        private readonly targets: Map<string, readonly string[]>,
        private readonly goalInvariantText: ReadonlyMap<string, string> = new Map(),
    ) {
        super()
    }

    setLegacyReplanAuthority(authority: BusMember): void {
        if (
            this.legacyReplanAuthority &&
            this.legacyReplanAuthority !== authority
        ) {
            throw new Error(
                "critic target legacy replan authority is already bound",
            )
        }
        this.legacyReplanAuthority = authority
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
        if (Replan.is(event)) {
            return
        }
        if (ReplanApplied.is(event)) {
            if (source !== this.legacyReplanAuthority) return
            for (const storyId of event.payload.removedStoryIds) {
                this.targets.delete(storyId)
            }
            for (const story of event.payload.addedStories) {
                if (story.acceptance?.length) {
                    this.targets.set(story.id, this.criteriaFor(story))
                } else {
                    this.targets.delete(story.id)
                }
            }
            return
        }
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
                    this.targets.set(story.id, this.criteriaFor(story))
                } else {
                    this.targets.delete(story.id)
                }
            }
        }
    }

    private criteriaFor(story: {
        acceptance?: readonly string[]
        goalInvariantIds?: readonly string[]
    }): readonly string[] {
        return criticCriteriaForStory(story, this.goalInvariantText)
    }
}
