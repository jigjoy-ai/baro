/**
 * What a story's next attempt should be told about the attempt that died.
 *
 * Measured: S2 of the zod migration was killed by SIGKILL twice. Each time it
 * had already established, by probing the compiler three times, that
 * `.default(v).optional()` is the only form that keeps a defaulted field
 * optional in the output type. That conclusion existed only in the dead
 * process. The third attempt derived it again from nothing.
 *
 * Agents do publish findings — `agent-collab note` reaches every later story —
 * but they publish at the end, when they report. Nothing an agent learns in
 * the middle survives it. This closes that window with what the host already
 * saw on the bus, so a restart resumes instead of restarting.
 *
 * Deliberately not a summary of the work: the files are already on the
 * attempt's preserved branch, and the recovery prompt hands those over. What
 * is lost, and only what is lost, is the reasoning.
 */

export interface AttemptCommand {
    readonly command: string
    readonly failed: boolean
}

export interface AttemptRecord {
    /** Newest last. */
    readonly statements: readonly string[]
    /** Newest last, deduplicated by command text. */
    readonly commands: readonly AttemptCommand[]
    readonly wrote: readonly string[]
}

export const MAX_RECALLED_STATEMENTS = 6
export const MAX_RECALLED_COMMANDS = 8
export const MAX_RECALLED_PATHS = 12
export const MAX_STATEMENT_CHARS = 600

export function emptyAttempt(): AttemptRecord {
    return { statements: [], commands: [], wrote: [] }
}

export function withStatement(record: AttemptRecord, text: string): AttemptRecord {
    const trimmed = text.trim()
    if (!trimmed) return record
    const statements = [
        ...record.statements,
        trimmed.slice(0, MAX_STATEMENT_CHARS),
    ]
    return {
        ...record,
        statements: statements.slice(-MAX_RECALLED_STATEMENTS),
    }
}

export function withCommand(
    record: AttemptRecord,
    command: string,
    failed: boolean,
): AttemptRecord {
    const trimmed = command.trim()
    if (!trimmed) return record
    // A command run twice says nothing twice; keep the latest verdict, which
    // is the one that made the agent move on.
    const commands = record.commands.filter((entry) => entry.command !== trimmed)
    commands.push({ command: trimmed, failed })
    return { ...record, commands: commands.slice(-MAX_RECALLED_COMMANDS) }
}

export function withWrite(record: AttemptRecord, path: string): AttemptRecord {
    const trimmed = path.trim()
    if (!trimmed || record.wrote.includes(trimmed)) return record
    return { ...record, wrote: [...record.wrote, trimmed].slice(-MAX_RECALLED_PATHS) }
}

/**
 * Silence is the default. An attempt that died before doing anything has
 * nothing to hand over, and a message an agent cannot use still costs it a
 * turn to read.
 */
export function recallForRetry(record: AttemptRecord): string | null {
    if (
        record.statements.length === 0 &&
        record.commands.length === 0 &&
        record.wrote.length === 0
    ) {
        return null
    }

    const lines = [
        "[baro] Your previous attempt at this story was killed before it could report.",
        "It was not rejected — nothing about your work was judged. This is what it",
        "had established, so you do not have to find it again.",
    ]

    if (record.statements.length > 0) {
        lines.push("", "What it had concluded, oldest first:")
        for (const statement of record.statements) lines.push(`  · ${statement}`)
    }

    const passed = record.commands.filter((entry) => !entry.failed)
    const failed = record.commands.filter((entry) => entry.failed)
    if (passed.length > 0) {
        lines.push("", "Commands it had passing:")
        for (const entry of passed) lines.push(`  ✓ ${entry.command}`)
    }
    if (failed.length > 0) {
        lines.push("", "Commands still failing when it died:")
        for (const entry of failed) lines.push(`  ✗ ${entry.command}`)
    }

    if (record.wrote.length > 0) {
        lines.push("", "Files it had written (its commits are on your branch already):")
        for (const path of record.wrote) lines.push(`  ${path}`)
    }

    lines.push(
        "",
        "Check the branch before redoing any of it.",
    )
    return lines.join("\n")
}
