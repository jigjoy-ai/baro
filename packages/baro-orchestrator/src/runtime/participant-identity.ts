import type { Participant } from "./mozaik.js"

/**
 * The agent a bus participant speaks for, or null when it speaks for none.
 *
 * Shared kernel: several contexts need to attribute an observation to a
 * story agent, and none of them should have to reach into another context to
 * do it. Identity is read from the participant the runtime handed us, never
 * from event payloads — a payload can claim any id it likes.
 */
export function participantAgentId(source: Participant): string | null {
    const candidate = (source as unknown as { agentId?: unknown }).agentId
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null
}
