import type { BusMember } from "../runtime/coordination.js"
import type { AgentPhase } from "../semantic-events.js"

export interface TerminalTurnSource extends BusMember {
    readonly agentId?: string
    getPhase?(): AgentPhase
}
