import { BaseObserver, type Participant, type SemanticEvent } from "@mozaik-ai/core"

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

export class CriticTargetRegistry extends BaseObserver {
    private legacyReplanAuthority: Participant | null = null
    private runtimeReplanAuthority: Participant | null = null
    private readonly seenRuntimeProposals = new Set<string>()
    private latestRuntimeGraphVersion = 0

    constructor(
        private readonly targets: Map<string, readonly string[]>,
        private readonly goalInvariantText: ReadonlyMap<string, string> = new Map(),
    ) {
        super()
    }

    setLegacyReplanAuthority(authority: Participant): void {
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
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (Replan.is(event)) {
            return
        }
        if (ReplanApplied.is(event)) {
            if (source !== this.legacyReplanAuthority) return
            for (const storyId of event.data.removedStoryIds) {
                this.targets.delete(storyId)
            }
            for (const story of event.data.addedStories) {
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
