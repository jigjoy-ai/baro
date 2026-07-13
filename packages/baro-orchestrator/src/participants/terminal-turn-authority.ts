import type { Participant, SemanticEvent } from "@mozaik-ai/core"

import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import { AgentResult, AgentTurnCompleted } from "../semantic-events.js"
import type { CriticInput } from "./critic-input.js"

/** Exact source capabilities used by terminal-turn policy consumers. */
export interface TerminalTurnAuthorityOptions {
    /** Collective registry for native AgentResult producers. */
    outcomeAuthority?: StoryOutcomeAuthority
    /** Exact projector allowed to publish normalized CLI terminal turns. */
    terminalProjectorAuthority?: Participant
}

/**
 * Authenticate terminal evidence before trusting its forgeable agentId.
 *
 * Collective native results must come from a participant registered for the
 * active story execution. Projected results are accepted only from the exact
 * projector capability. Legacy native AgentResult remains compatible because
 * it has no run-scoped execution registry, while its projected path can still
 * be bound exactly by orchestrate().
 */
export function isAuthorizedTerminalTurn(
    source: Participant,
    event: SemanticEvent<unknown>,
    input: CriticInput,
    authorities: TerminalTurnAuthorityOptions,
): boolean {
    if (AgentTurnCompleted.is(event)) {
        const projector = authorities.terminalProjectorAuthority
        if (projector) return source === projector
        return authorities.outcomeAuthority === undefined
    }

    if (AgentResult.is(event)) {
        const outcome = authorities.outcomeAuthority
        return outcome === undefined ||
            outcome.matchesTerminalTurnSource(source, input.agentId)
    }

    return false
}
