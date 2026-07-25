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

    observe(event: SemanticEvent<unknown>, runId: string | undefined): boolean {
        if (WorkLeaseGranted.is(event)) {
            if (!runId || event.data.runId === runId) {
                this.byStory.set(event.data.request.storyId, {
                    runId: event.data.runId,
                    leaseId: event.data.leaseId,
                    generation: event.data.generation,
                })
            }
            return true
        }
        if (WorkLeaseReleased.is(event)) {
            if (!runId || event.data.runId === runId) {
                const lease = this.byStory.get(event.data.storyId)
                if (lease?.leaseId === event.data.leaseId) {
                    this.byStory.delete(event.data.storyId)
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
