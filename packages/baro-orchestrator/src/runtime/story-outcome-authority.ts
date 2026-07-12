import type { Participant } from "@mozaik-ai/core"

import type {
    StoryResultData,
    StorySpawnFailedData,
} from "../semantic-events.js"

export interface StorySpawnAuthorityCorrelation {
    runId: string
    storyId: string
    leaseId: string
}

export interface StoryResultAuthorityCorrelation
    extends StorySpawnAuthorityCorrelation {
    generation: number
}

/**
 * Run-scoped, object-identity authority registry for dynamic story outcomes.
 *
 * A story factory is the only valid source of a spawn failure for the lease it
 * accepted. Once an executor constructs the concrete participant, that exact
 * participant becomes the only valid source of the terminal StoryResult for
 * the lease generation. Agent ids are deliberately not consulted: they are
 * event payload and therefore forgeable.
 */
export class StoryOutcomeAuthority {
    private readonly spawnAuthorities = new Map<string, Participant>()
    private readonly resultAuthorities = new Map<string, Participant>()

    constructor(public readonly runId: string) {
        if (!runId.trim()) {
            throw new Error("StoryOutcomeAuthority runId must not be empty")
        }
    }

    registerSpawnAuthority(
        correlation: StorySpawnAuthorityCorrelation,
        source: Participant,
    ): void {
        this.assertSpawnCorrelation(correlation)
        registerIdentity(
            this.spawnAuthorities,
            spawnKey(correlation),
            source,
            `spawn outcome for ${describeSpawn(correlation)}`,
        )
    }

    registerResultAuthority(
        correlation: StoryResultAuthorityCorrelation,
        source: Participant,
    ): void {
        this.assertResultCorrelation(correlation)
        registerIdentity(
            this.resultAuthorities,
            resultKey(correlation),
            source,
            `story result for ${describeResult(correlation)}`,
        )
    }

    matchesSpawnFailure(
        source: Participant,
        failure: StorySpawnFailedData,
    ): boolean {
        if (
            failure.runId !== this.runId ||
            !failure.storyId ||
            !failure.leaseId
        ) return false
        return this.spawnAuthorities.get(spawnKey({
            runId: failure.runId,
            storyId: failure.storyId,
            leaseId: failure.leaseId,
        })) === source
    }

    matchesResult(source: Participant, result: StoryResultData): boolean {
        if (
            result.runId !== this.runId ||
            !result.storyId ||
            !result.leaseId ||
            result.generation == null
        ) return false
        return this.resultAuthorities.get(resultKey({
            runId: result.runId,
            storyId: result.storyId,
            leaseId: result.leaseId,
            generation: result.generation,
        })) === source
    }

    /**
     * Authorize a non-terminal runtime action emitted by the concrete story
     * participant for one exact lease generation.  Runtime DAG proposals use
     * this instead of trusting the forgeable `agentId` carried by a source.
     */
    matchesResultAuthority(
        source: Participant,
        correlation: StoryResultAuthorityCorrelation,
    ): boolean {
        if (
            correlation.runId !== this.runId ||
            !correlation.storyId ||
            !correlation.leaseId ||
            !Number.isInteger(correlation.generation) ||
            correlation.generation < 0
        ) return false
        return this.resultAuthorities.get(resultKey(correlation)) === source
    }

    private assertSpawnCorrelation(
        correlation: StorySpawnAuthorityCorrelation,
    ): void {
        if (
            correlation.runId !== this.runId ||
            !correlation.storyId ||
            !correlation.leaseId
        ) {
            throw new Error(
                `invalid spawn authority correlation for run ${this.runId}`,
            )
        }
    }

    private assertResultCorrelation(
        correlation: StoryResultAuthorityCorrelation,
    ): void {
        this.assertSpawnCorrelation(correlation)
        if (!Number.isInteger(correlation.generation) || correlation.generation < 0) {
            throw new Error(
                `invalid result authority generation for ${describeSpawn(correlation)}`,
            )
        }
    }
}

function registerIdentity(
    registry: Map<string, Participant>,
    key: string,
    source: Participant,
    description: string,
): void {
    const current = registry.get(key)
    if (current === source) return
    if (current) {
        throw new Error(`conflicting authority registration: ${description}`)
    }
    registry.set(key, source)
}

function spawnKey(correlation: StorySpawnAuthorityCorrelation): string {
    return JSON.stringify([
        correlation.runId,
        correlation.storyId,
        correlation.leaseId,
    ])
}

function resultKey(correlation: StoryResultAuthorityCorrelation): string {
    return JSON.stringify([
        correlation.runId,
        correlation.storyId,
        correlation.leaseId,
        correlation.generation,
    ])
}

function describeSpawn(correlation: StorySpawnAuthorityCorrelation): string {
    return `${correlation.runId}/${correlation.storyId}/${correlation.leaseId}`
}

function describeResult(correlation: StoryResultAuthorityCorrelation): string {
    return `${describeSpawn(correlation)}/${correlation.generation}`
}
