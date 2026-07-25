import { createHash } from "node:crypto"

import type { SemanticEvent } from "../runtime/mozaik.js"

import { AgentResult, AgentTurnCompleted } from "../semantic-events.js"

export interface CriticInput {
    agentId: string
    isError: boolean
    resultText: string | null
    canContinue: boolean
    /** Present when the provider stream exposes enough stable replay identity. */
    terminalId: string | null
}

/** Scope producer IDs to their logical agent before storing them in a Critic. */
export function criticReplayKey(
    agentId: string,
    terminalId: string | null,
): string | null {
    return terminalId ? JSON.stringify([agentId, terminalId]) : null
}

/** Compatibility bridge: Claude/OpenAI retain AgentResult; one-shot CLIs use the neutral event. */
export function criticInput(event: SemanticEvent<unknown>): CriticInput | null {
    if (AgentTurnCompleted.is(event)) {
        return {
            ...event.data,
            terminalId: explicitTerminalId(event.data.terminalId),
        }
    }
    if (AgentResult.is(event)) {
        const explicit = explicitTerminalId(event.data.terminalId)
        const hasLegacyIdentity =
            Boolean(event.data.sessionId) || event.data.numTurns !== null
        return {
            agentId: event.data.agentId,
            isError: event.data.isError,
            resultText: event.data.resultText,
            canContinue: true,
            terminalId:
                explicit ??
                (hasLegacyIdentity
                    ? createHash("sha256")
                          .update(JSON.stringify(event.data))
                          .digest("hex")
                    : null),
        }
    }
    return null
}

function explicitTerminalId(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null
}
