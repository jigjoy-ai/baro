import type { SemanticEvent } from "./mozaik.js"

import {
    WorkLeaseGranted,
    WorkLeaseReleased,
    type StoryResultData,
} from "../semantic-events.js"

export class ActiveLeaseRegistry {
    private readonly byStory = new Map<
        string,
        { runId: string; leaseId: string; generation: number }
    >()

    observe(event: SemanticEvent<string, unknown>, runId: string | undefined): boolean {
        if (WorkLeaseGranted.is(event)) {
            if (!runId || event.payload.runId === runId) {
                this.byStory.set(event.payload.request.storyId, {
                    runId: event.payload.runId,
                    leaseId: event.payload.leaseId,
                    generation: event.payload.generation,
                })
            }
            return true
        }
        if (WorkLeaseReleased.is(event)) {
            if (!runId || event.payload.runId === runId) {
                const lease = this.byStory.get(event.payload.storyId)
                if (lease?.leaseId === event.payload.leaseId) {
                    this.byStory.delete(event.payload.storyId)
                }
            }
            return true
        }
        return false
    }

    matches(result: StoryResultData, runId: string | undefined): boolean {
        const lease = this.byStory.get(result.storyId)
        return (
            !!runId &&
            !!lease &&
            lease.runId === runId &&
            result.runId === lease.runId &&
            result.leaseId === lease.leaseId &&
            result.generation === lease.generation
        )
    }

    consumeResult(result: StoryResultData, runId: string | undefined): boolean {
        if (!this.matches(result, runId)) return false
        this.byStory.delete(result.storyId)
        return true
    }

    hasActive(storyId: string, runId: string | undefined): boolean {
        const active = this.byStory.get(storyId)
        return !!active && !!runId && active.runId === runId
    }

    matchesLease(
        storyId: string,
        runId: string | undefined,
        leaseId: string | undefined,
    ): boolean {
        const active = this.byStory.get(storyId)
        return (
            !!active &&
            runId === active.runId &&
            leaseId === active.leaseId
        )
    }

    matchesLeaseGeneration(
        storyId: string,
        runId: string | undefined,
        leaseId: string | undefined,
        generation: number | undefined,
    ): boolean {
        const active = this.byStory.get(storyId)
        return (
            !!active &&
            runId === active.runId &&
            leaseId === active.leaseId &&
            generation === active.generation
        )
    }
}
