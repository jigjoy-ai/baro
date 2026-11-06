import assert from "node:assert/strict"

import type { SemanticEvent } from "../../src/runtime/mozaik.js"
import type { BusMember } from "../../src/runtime/coordination.js"
import {
    StoryFactory,
    type StoryFactoryOptions,
} from "../../src/market/story-factory.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    StoryResult,
    StorySpawnRequest,
    WorkLeaseGranted,
    type StoryResultData,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import {
    joinWithCapture,
    source,
    type CapturedEnvironment,
} from "../execution/helpers.js"

export const RUN_ID = "run-factory"
export const WORKER_ID = "worker-a"

type LeaseRequest = Partial<Omit<StorySpawnRequestData, "storyId">>

export interface LeasedFactory {
    factory: StoryFactory
    broker: BusMember
    env: CapturedEnvironment
    /** Grants one lease and returns the spawn request the factory projected. */
    lease(
        storyId: string,
        request?: LeaseRequest,
    ): Promise<SemanticEvent<string, StorySpawnRequestData>>
    /** A StoryResult correlated to the lease `lease()` granted. */
    result(storyId: string, fields?: Partial<StoryResultData>): ReturnType<typeof StoryResult.create>
}

/** A StoryFactory bound to fixed broker/board/outcome authorities, so a test
 * can drive spawns through the lease path the Board uses. */
export function leasedFactory(
    options: Omit<StoryFactoryOptions, "runId"> & Partial<Pick<StoryFactoryOptions, "runId">>,
): LeasedFactory {
    const broker = options.leaseAuthority ?? source("broker")
    const factory = new StoryFactory({
        runId: RUN_ID,
        workerId: WORKER_ID,
        offerAuthority: source("board"),
        outcomeAuthority: new StoryOutcomeAuthority(RUN_ID),
        ...options,
        leaseAuthority: broker,
    })
    const env = joinWithCapture(factory)
    return {
        factory,
        broker,
        env,
        async lease(storyId, request = {}) {
            await factory.onExternalEvent(
                broker,
                WorkLeaseGranted.create({
                    runId: RUN_ID,
                    offerId: `offer-${storyId}`,
                    leaseId: `lease-${storyId}`,
                    workerId: WORKER_ID,
                    generation: 1,
                    request: {
                        storyId,
                        prompt: `Implement ${storyId}`,
                        model: "sonnet",
                        retries: 0,
                        timeoutSecs: 30,
                        ...request,
                    },
                }),
            )
            const spawn = env.events
                .filter(StorySpawnRequest.is)
                .filter((event) => event.payload.storyId === storyId)
                .at(-1)
            assert.ok(spawn, `no spawn request projected for ${storyId}`)
            return spawn
        },
        result(storyId, fields = {}) {
            return StoryResult.create({
                storyId,
                success: true,
                attempts: 1,
                durationSecs: 1,
                error: null,
                runId: RUN_ID,
                leaseId: `lease-${storyId}`,
                generation: 1,
                ...fields,
            })
        },
    }
}

export async function flushBus(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
}
