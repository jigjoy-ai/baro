/** Must match contract.rs:107-110 in crates/baro-tui exactly; both sides slug this same rendered prompt. */
const GOAL_ENVELOPE_HEADER = "Goal envelope (confirmed before planning)"

/**
 * The rendered planning prompt leads with the envelope header, not the
 * objective; slugging it verbatim produces a branch name from boilerplate.
 * Pull the Objective line out instead, falling back to the goal unchanged
 * for any other shape.
 */
export function objectiveLine(goal: string): string {
    const trimmedGoal = goal.trim()
    if (!trimmedGoal.startsWith(GOAL_ENVELOPE_HEADER)) {
        return goal
    }
    const lines = trimmedGoal.split("\n")
    const objectiveIndex = lines.findIndex((line) => line.trim() === "Objective:")
    if (objectiveIndex === -1) {
        return goal
    }
    for (let i = objectiveIndex + 1; i < lines.length; i++) {
        const candidate = lines[i]!.trim()
        if (candidate) {
            return candidate
        }
    }
    return goal
}
