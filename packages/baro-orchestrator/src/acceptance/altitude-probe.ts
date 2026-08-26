/**
 * The only I/O owner for the altitude dimension: every git invocation and file
 * read for the measurement lives here, and every decision is delegated to the
 * pure module. The probe fails closed to no findings, because an advisory
 * measurement must never be able to break the critic evaluation hosting it.
 */

import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import { runRepositoryCommand } from "../integration/repository-command.js"
import {
    ALTITUDE_GROWTH_LINES,
    addedPathsFromNameStatus,
    altitudeFindings,
    countLines,
    isAltitudeExemptPath,
    parseNumstat,
    type AltitudeDiffStat,
    type AltitudeFinding,
} from "./altitude.js"

/** Reads stay cheap on the critic path even when a story touches everything. */
const MAX_FILES_READ = 25
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_BUFFER = 512 * 1024

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"] as const

export interface AltitudeProbeOptions {
    readonly cwd: string
    readonly baseSha: string
    readonly timeoutMs: number
}

export async function collectAltitudeFindings(
    opts: AltitudeProbeOptions,
): Promise<AltitudeFinding[]> {
    try {
        return await probe(opts)
    } catch {
        return []
    }
}

async function probe(opts: AltitudeProbeOptions): Promise<AltitudeFinding[]> {
    const run = (args: readonly string[]) =>
        runRepositoryCommand("git", args, {
            cwd: opts.cwd,
            timeoutMs: opts.timeoutMs,
            maxBuffer: MAX_BUFFER,
        })

    // allSettled, not all: a rejected diff must not leave a sibling git process
    // still running after this function has already returned.
    const results = await Promise.allSettled([
        run(["diff", ...DIFF_FLAGS, "--numstat", opts.baseSha, "--"]),
        run(["diff", ...DIFF_FLAGS, "--name-status", opts.baseSha, "--"]),
        run(["ls-files", "--others", "--exclude-standard", "-z"]),
    ])
    const [numstat, nameStatus, untracked] = results
    if (
        numstat.status === "rejected" ||
        nameStatus.status === "rejected" ||
        untracked.status === "rejected"
    ) {
        return []
    }

    const stats = parseNumstat(numstat.value.stdout)
    const newPaths = addedPathsFromNameStatus(nameStatus.value.stdout)
    for (const path of untracked.value.stdout.split("\0")) {
        if (path !== "") newPaths.add(path)
    }

    const lineCounts = await readLineCounts(opts.cwd, stats)
    const resolved = stats.map((stat) => ({
        ...stat,
        isNew: newPaths.has(stat.path),
    }))
    return altitudeFindings(resolved, (path) => lineCounts.get(path) ?? null)
}

/**
 * Filtering before reading is what keeps the probe cheap and is why an exempt
 * path never reaches the filesystem at all.
 */
async function readLineCounts(
    cwd: string,
    stats: readonly AltitudeDiffStat[],
): Promise<Map<string, number>> {
    const eligible = new Set<string>()
    for (const stat of stats) {
        if (stat.addedLines < ALTITUDE_GROWTH_LINES) continue
        if (isAltitudeExemptPath(stat.path)) continue
        eligible.add(stat.path)
    }
    const paths = [...eligible]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_FILES_READ)

    const lineCounts = new Map<string, number>()
    for (const path of paths) {
        const total = await readLineCount(cwd, path)
        if (total !== null) lineCounts.set(path, total)
    }
    return lineCounts
}

async function readLineCount(
    cwd: string,
    path: string,
): Promise<number | null> {
    if (isAbsolute(path)) return null
    const target = resolve(cwd, path)
    if (relative(cwd, target).startsWith("..")) return null
    const stat = await lstat(target)
    if (!stat.isFile()) return null
    if (stat.size > MAX_FILE_BYTES) return null
    return countLines(await readFile(target, "utf8"))
}
