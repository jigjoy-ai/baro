/**
 * What a lane is, in the only terms planning needs.
 *
 * A session says what the model must be able to do — read this repository,
 * call this function of ours — and a lane answers with whatever that means on
 * its side. Nothing above this line knows that one lane spawns a process and
 * reaches back through MCP while another is handed the function, which is the
 * whole point: the MCP relay is a concession to a model living in another
 * process, and concessions belong in the adapter that needs them.
 *
 * Adding a lane is answering three questions — which backend, what a capability
 * costs there, and how to build the participant. No session changes.
 */

import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "./interactive-participant.js"
import type { Tool } from "../runtime/mozaik.js"

/** A function the host owns and the model may call. */
export interface HostFunction {
    readonly name: string
    readonly description: string
    /** JSON Schema for the arguments, as both lanes advertise it. */
    readonly parameters: Record<string, unknown>
    invoke(args: unknown): Promise<string>
}

export type LaneCapability =
    /** Read the repository: open files, list, grep. Never write. */
    | { readonly kind: "read-repo"; readonly cwd: string }
    /** Call back into this process. The capability lanes differ most on. */
    | { readonly kind: "host-function"; readonly fn: HostFunction }

/**
 * A granted set of capabilities, in whichever form the lane consumes.
 *
 * `close` is the lane's own cleanup — a relay to shut down, a socket to
 * release. A caller that opens a grant owes it a close, whatever happens to
 * the session.
 */
export interface LaneGrant {
    readonly tools?: readonly Tool[]
    readonly cliExtraArgs?: readonly string[]
    close(): Promise<void>
}

export class LaneCapabilityUnsupported extends Error {
    override readonly name = "LaneCapabilityUnsupported"
    constructor(backend: string, capability: string) {
        super(`the ${backend} lane cannot grant "${capability}"`)
    }
}

export interface InteractiveLaneAdapter {
    readonly backend: string
    /**
     * Translate capabilities, or refuse one by name. Refusing is a first-class
     * answer: a lane without a way to expose our functions can still hold an
     * architect session and must not pretend it can hold a planner's.
     */
    grant(capabilities: readonly LaneCapability[]): Promise<LaneGrant>
    create(
        request: InteractiveParticipantRequest,
        grant: LaneGrant,
    ): InteractiveModelParticipant<unknown>
}

export const EMPTY_GRANT: LaneGrant = Object.freeze({
    close: async () => {},
})

/** Compose several grants, closing all of them exactly once. */
export function mergeGrants(grants: readonly LaneGrant[]): LaneGrant {
    return {
        tools: grants.flatMap((grant) => [...(grant.tools ?? [])]),
        cliExtraArgs: grants.flatMap((grant) => [...(grant.cliExtraArgs ?? [])]),
        close: async () => {
            // Every grant is closed even if an earlier one throws; the first
            // failure is reported once the rest have been released.
            let failure: unknown = null
            for (const grant of grants) {
                try {
                    await grant.close()
                } catch (error) {
                    failure ??= error
                }
            }
            if (failure) throw failure
        },
    }
}
