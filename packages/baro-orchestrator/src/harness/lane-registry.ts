/**
 * Which lane answers for a backend.
 *
 * One map, so adding a lane is registering it. The previous shape of this file
 * decided by naming lanes ("cli" or "native") and then built a Claude
 * participant for everything in the first group — which would have handed an
 * opencode run a Claude process. A lane is not a category; it is an adapter.
 */

import { ClaudeLaneAdapter } from "./claude/lane-adapter.js"
import { MozaikLaneAdapter } from "./mozaik/lane-adapter.js"
import type { CliHostFunctionBridge } from "./claude/lane-adapter.js"
import type { InteractiveLaneAdapter } from "./lane-adapter.js"
import type { OpenAIConnection } from "./openai/runtime.js"

export interface LaneResolutionOptions {
    readonly backend: string
    /** Endpoint for a lane that calls a model directly. */
    readonly connection?: OpenAIConnection
    readonly claudeBin?: string
    /** How a process-bound lane reaches our functions, when one can. */
    readonly hostFunctionBridge?: CliHostFunctionBridge
}

type LaneBuilder = (options: LaneResolutionOptions) => InteractiveLaneAdapter

/**
 * Every backend that is a model we call directly resolves to the mozaik lane —
 * the native runner, any OpenAI-compatible endpoint, our own gateway. Only a
 * backend that is genuinely another program needs its own entry.
 */
const LANES = new Map<string, LaneBuilder>([
    [
        "claude",
        (options) => new ClaudeLaneAdapter({
            ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
            ...(options.hostFunctionBridge
                ? { hostFunctionBridge: options.hostFunctionBridge }
                : {}),
        }),
    ],
])

export function registerLane(backend: string, build: LaneBuilder): void {
    LANES.set(backend, build)
}

export function laneAdapterFor(
    options: LaneResolutionOptions,
): InteractiveLaneAdapter {
    const build = LANES.get(options.backend)
    if (build) return build(options)
    return new MozaikLaneAdapter({
        backend: options.backend,
        ...(options.connection ? { connection: options.connection } : {}),
    })
}

/** True when this backend is held by a model we call inside our own loop. */
export function isNativeLane(backend: string): boolean {
    return !LANES.has(backend)
}
