import type {
    PlanCompleteCommand,
    PlanFailedCommand,
    PlanFragmentCommand,
    PlanningOpenCommand,
} from "../../stdin-commands.js"

/**
 * Private progressive-planning ingress. The feed owns correlation, payload
 * validation, and lifecycle policy; stdin dispatch only preserves the wire
 * command and must never make the run depend on this optional lane.
 */
export interface PlanningFeedContract {
    open: (command: PlanningOpenCommand) => void
    fragment: (command: PlanFragmentCommand) => void
    complete: (command: PlanCompleteCommand) => void
    failed: (command: PlanFailedCommand) => void
}
