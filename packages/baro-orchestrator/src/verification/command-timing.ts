import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import { baroHome } from "../runtime/baro-home.js"

// Silence alone no longer kills a command, so every command also carries a
// hard wall-clock ceiling; without it a silent-but-busy process is unbounded.
export const ABSOLUTE_COMMAND_TIMEOUT_MS = 10 * 60_000

export interface TimedCommand {
    readonly label: string
    readonly tool: string
    readonly args: readonly string[]
    readonly cwd?: string
}

export interface CommandTiming {
    lastMs: number
    at: string
}

export type CommandTimings = Record<string, CommandTiming>

/** Relative to the verified tree, so per-run worktree paths share one key. */
export function commandKey(cmd: TimedCommand, root: string): string {
    const rel = cmd.cwd ? relative(resolve(root), resolve(root, cmd.cwd)) : ""
    return `${rel || "."}::${[cmd.tool, ...cmd.args].join(" ")}`
}

export function timingsFile(): string {
    return join(baroHome(), "verification-timings.json")
}

function repoId(repoRoot: string): string {
    let canonical = resolve(repoRoot)
    try {
        canonical = realpathSync(canonical)
    } catch {}
    return createHash("sha1").update(canonical).digest("hex")
}

function readAll(): Record<string, CommandTimings> {
    try {
        const parsed = JSON.parse(readFileSync(timingsFile(), "utf8")) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, CommandTimings>)
            : {}
    } catch {
        return {}
    }
}

export function loadTimings(repoRoot: string): CommandTimings {
    const entry = readAll()[repoId(repoRoot)]
    return entry && typeof entry === "object" ? entry : {}
}

export function recordTiming(repoRoot: string, key: string, ms: number): void {
    const file = timingsFile()
    const all = readAll()
    const id = repoId(repoRoot)
    all[id] = { ...(all[id] ?? {}), [key]: { lastMs: ms, at: new Date().toISOString() } }
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2))
    renameSync(tmp, file)
}

/** `baro.verification.commandTimeoutsSecs` in the root package.json, by label. */
export function declaredTimeoutsSecs(root: string): Record<string, number> {
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            baro?: { verification?: { commandTimeoutsSecs?: unknown } }
        }
        const raw = pkg.baro?.verification?.commandTimeoutsSecs
        if (!raw || typeof raw !== "object") return {}
        const out: Record<string, number> = {}
        for (const [label, secs] of Object.entries(raw)) {
            if (typeof secs === "number" && Number.isFinite(secs) && secs > 0) {
                out[label] = secs
            }
        }
        return out
    } catch {
        return {}
    }
}

export function commandCeilingMs(opts: {
    declaredSecs?: number
    lastMs?: number
    floorMs?: number
}): number {
    const derived = opts.declaredSecs
        ? opts.declaredSecs * 1000
        : opts.lastMs
          ? 2 * opts.lastMs
          : 0
    return Math.max(opts.floorMs ?? ABSOLUTE_COMMAND_TIMEOUT_MS, derived)
}

export interface CommandCeiling {
    ceilingMs: number
    lastMs?: number
    key: string
}

/** Snapshot of the declaration and persisted timings for one verification. */
export function createCeilingResolver(
    root: string,
    repoRoot: string,
    floorMs?: number,
): (cmd: TimedCommand) => CommandCeiling {
    const declared = declaredTimeoutsSecs(root)
    const timings = loadTimings(repoRoot)
    return (cmd) => {
        const key = commandKey(cmd, root)
        const lastMs = timings[key]?.lastMs
        const measured = typeof lastMs === "number" && lastMs > 0 ? lastMs : undefined
        return {
            key,
            ceilingMs: commandCeilingMs({
                declaredSecs: declared[cmd.label],
                lastMs: measured,
                floorMs,
            }),
            ...(measured !== undefined ? { lastMs: measured } : {}),
        }
    }
}
