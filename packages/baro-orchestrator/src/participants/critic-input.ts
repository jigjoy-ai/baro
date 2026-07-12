import { createHash } from "node:crypto"

import type { SemanticEvent } from "@mozaik-ai/core"

import { AgentResult, AgentTurnCompleted } from "../semantic-events.js"

export interface CriticInput {
    agentId: string
    isError: boolean
    resultText: string | null
    canContinue: boolean
    /** Present when the provider stream exposes enough stable replay identity. */
    terminalId: string | null
}

/** Compatibility bridge: Claude/OpenAI retain AgentResult; one-shot CLIs use the neutral event. */
export function criticInput(event: SemanticEvent<unknown>): CriticInput | null {
    if (AgentTurnCompleted.is(event)) {
        return { ...event.data, terminalId: null }
    }
    if (AgentResult.is(event)) {
        return {
            agentId: event.data.agentId,
            isError: event.data.isError,
            resultText: event.data.resultText,
            canContinue: true,
            terminalId: createHash("sha256")
                .update(JSON.stringify(event.data))
                .digest("hex"),
        }
    }
    return null
}
