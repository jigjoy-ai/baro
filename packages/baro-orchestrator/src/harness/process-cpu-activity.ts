/**
 * Read-only CPU-time sampler for a spawned process tree.
 *
 * The idle watchdog needs a second opinion before it calls a silent command
 * hung: a compiler or test runner can go minutes without writing a byte while
 * pinning a core. This is the only place that shells out for CPU data; the
 * termination machinery in process-tree.ts stays untouched and only its pure
 * traversal is reused.
 */

import { execFile } from "node:child_process"

import {
    descendantsFromParentPairs,
    POSIX_PROCESS_GROUPS_SUPPORTED,
} from "./process-tree.js"

export interface CpuActivitySample {
    readonly at: number
    readonly totalCpuMs: number | null
    /** False when the platform or the probe could not report CPU time at all. */
    readonly observed: boolean
}

export interface ProcessCpuRow {
    readonly pid: number
    readonly parentPid: number
    readonly cpuMs: number
}

export type ProcessCpuTableReader = () => Promise<readonly ProcessCpuRow[] | null>

export type CpuActivityProbe = (
    rootPid: number,
    previous: CpuActivitySample | null,
) => Promise<{ active: boolean; sample: CpuActivitySample }>

export const CPU_PROBE_TIMEOUT_MS = 5_000
/** `ps` reports CPU time at 1-second resolution, so nothing finer is signal. */
export const CPU_ADVANCE_MIN_DELTA_MS = 1_000
/** Share of one core a tree must sustain across the window to count as busy. */
export const CPU_ACTIVE_MIN_FRACTION = 0.05

const CPU_PROBE_MAX_BUFFER = 4 * 1024 * 1024

/** `[[dd-]hh:]mm:ss[.cc]` as emitted by `ps -o time=`. */
function parsePsTime(value: string): number | null {
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/u.exec(value)
    if (!match) return null
    const [, days, hours, minutes, seconds, fraction] = match
    const centis = fraction ? Number(fraction.padEnd(2, "0").slice(0, 2)) : 0
    return (
        (Number(days ?? 0) * 86_400 +
            Number(hours ?? 0) * 3_600 +
            Number(minutes) * 60 +
            Number(seconds)) *
            1_000 +
        centis * 10
    )
}

function parseCpuTable(stdout: string): readonly ProcessCpuRow[] | null {
    const rows: ProcessCpuRow[] = []
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim()
        if (trimmed === "") continue
        const fields = trimmed.split(/\s+/u)
        if (fields.length !== 3) return null
        const pid = Number(fields[0])
        const parentPid = Number(fields[1])
        const cpuMs = parsePsTime(fields[2]!)
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || cpuMs === null) {
            return null
        }
        rows.push({ pid, parentPid, cpuMs })
    }
    return rows.length > 0 ? rows : null
}

const defaultReadTable: ProcessCpuTableReader = () =>
    new Promise((resolve) => {
        if (!POSIX_PROCESS_GROUPS_SUPPORTED) {
            resolve(null)
            return
        }
        execFile(
            "ps",
            ["-Ao", "pid=,ppid=,time="],
            { timeout: CPU_PROBE_TIMEOUT_MS, maxBuffer: CPU_PROBE_MAX_BUFFER },
            (error, stdout) => {
                resolve(error ? null : parseCpuTable(stdout))
            },
        )
    })

export async function sampleProcessTreeCpu(
    rootPid: number,
    readTable: ProcessCpuTableReader = defaultReadTable,
): Promise<CpuActivitySample> {
    let rows: readonly ProcessCpuRow[] | null
    try {
        rows = await readTable()
    } catch {
        rows = null
    }
    if (!rows) return { at: Date.now(), totalCpuMs: null, observed: false }

    const tree = new Set<number>([
        rootPid,
        ...descendantsFromParentPairs(
            rootPid,
            rows.map((row) => [row.pid, row.parentPid] as const),
        ),
    ])
    let totalCpuMs = 0
    for (const row of rows) {
        if (tree.has(row.pid)) totalCpuMs += row.cpuMs
    }
    return { at: Date.now(), totalCpuMs, observed: true }
}

/** An unobservable tree counts as busy; the absolute ceiling is the backstop. */
export function cpuAdvanced(
    previous: CpuActivitySample,
    current: CpuActivitySample,
    minDeltaMs: number = CPU_ADVANCE_MIN_DELTA_MS,
): boolean {
    if (!previous.observed || !current.observed) return true
    // Window-relative: a fixed floor alone reads a briefly-booting process as
    // busy across a five-minute window, and a busy one as idle across a short one.
    const elapsedMs = Math.max(0, current.at - previous.at)
    const required = Math.max(minDeltaMs, elapsedMs * CPU_ACTIVE_MIN_FRACTION)
    return current.totalCpuMs! - previous.totalCpuMs! >= required
}

/**
 * Default probe for the idle watchdog. The spawn-time sample is what lets the
 * FIRST expiry be measured instead of assumed, so a silent, idle command dies
 * at the end of its first no-output window rather than the second.
 */
export function createDefaultCpuActivityProbe(
    rootPid: number | undefined,
): CpuActivityProbe {
    const baseline: Promise<CpuActivitySample> =
        rootPid === undefined
            ? Promise.resolve({ at: Date.now(), totalCpuMs: null, observed: false })
            : sampleProcessTreeCpu(rootPid)
    return async (pid, previous) => {
        const reference = previous ?? (await baseline)
        const current = await sampleProcessTreeCpu(pid)
        return { active: cpuAdvanced(reference, current), sample: current }
    }
}
