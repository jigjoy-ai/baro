import type { VerificationCommandEvidence } from "../events/verification.js"

/** A check on the diff's shape, not on whether the merged code builds or passes. */
export function isHygieneCommand(command: string): boolean {
    return /^git\s+diff\s+--check\b/u.test(command.trim())
}

/**
 * Every command passed and none of them built or tested anything. A plan that
 * declares only `git diff --check` used to turn such a run into a verified
 * one (#210): the merged result of a Maven project was reported `passed` on
 * whitespace alone.
 */
export function provesOnlyHygiene(
    commands: readonly Pick<VerificationCommandEvidence, "command" | "status">[],
): boolean {
    return (
        commands.length > 0 &&
        commands.every(
            (command) =>
                command.status === "passed" && isHygieneCommand(command.command),
        )
    )
}
