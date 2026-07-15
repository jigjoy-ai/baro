import type { ChildProcess } from "node:child_process"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"

/**
 * Signal a child and every descendant visible at the time of the call.
 *
 * Provider CLIs frequently launch a second process. `ChildProcess.kill()` only
 * addresses the shim/CLI process, so a timeout could otherwise leave the paid
 * provider request running. Children are deliberately not spawned detached:
 * that lets the Rust supervisor's Unix process group remain the final safety
 * boundary around the Node process and all of its provider descendants.
 */
export function signalProcessTree(
    child: ChildProcess,
    signal: NodeJS.Signals,
    previouslySeen: ReadonlySet<number> = new Set(),
): Set<number> {
    const rootPid = child.pid
    const seen = new Set(previouslySeen)
    if (rootPid === undefined) {
        try {
            child.kill(signal)
        } catch {
            // The process may have exited between the caller's state check and
            // this signal attempt.
        }
        return seen
    }

    seen.add(rootPid)

    if (process.platform === "win32") {
        // Windows does not expose POSIX-style graceful signals for console
        // trees. `taskkill /T /F` is the OS-provided, shell-free equivalent
        // and prevents a `.cmd` shim from leaving its real CLI behind.
        try {
            execFileSync(
                "taskkill",
                ["/PID", String(rootPid), "/T", "/F"],
                { stdio: "ignore", windowsHide: true, timeout: 5_000 },
            )
        } catch {
            try {
                child.kill(signal)
            } catch {
                // Already gone.
            }
        }
        return seen
    }

    if (process.platform !== "linux" && process.platform !== "darwin") {
        try {
            child.kill(signal)
        } catch {
            // Already gone.
        }
        return seen
    }

    for (const pid of descendantsOf(rootPid)) seen.add(pid)

    // Descendants first keeps the root around long enough to make the complete
    // parent/child relationship observable. A later SIGKILL call receives the
    // captured set too, covering children that were re-parented after SIGTERM.
    const ordered = [...seen].filter((pid) => pid !== rootPid).reverse()
    ordered.push(rootPid)
    for (const pid of ordered) {
        try {
            process.kill(pid, signal)
        } catch {
            // ESRCH is expected when graceful shutdown wins the race.
        }
    }
    return seen
}

export function anyProcessAlive(pids: ReadonlySet<number>): boolean {
    for (const pid of pids) {
        try {
            process.kill(pid, 0)
            return true
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === "EPERM") return true
        }
    }
    return false
}

function descendantsOf(rootPid: number): number[] {
    if (process.platform === "linux") {
        // `/proc` is part of Linux's process API and is available in minimal
        // containers where the procps `ps` package often is not. The kernel's
        // children list is also argv/locale independent. Fall back to PPid
        // status records for older/restricted procfs mounts, then to `ps`.
        const fromChildren = descendantsFromProcChildren(rootPid)
        if (fromChildren !== null) return fromChildren
        const fromStatuses = descendantsFromProcStatuses(rootPid)
        if (fromStatuses !== null) return fromStatuses
    }

    return descendantsFromPs(rootPid)
}

function descendantsFromProcChildren(rootPid: number): number[] | null {
    const rootChildren = readProcChildren(rootPid)
    if (rootChildren === null) return null

    const descendants: number[] = []
    const pending = [...rootChildren]
    const visited = new Set<number>()
    while (pending.length > 0) {
        const pid = pending.shift()!
        if (visited.has(pid)) continue
        visited.add(pid)
        descendants.push(pid)
        // A descendant can exit while the snapshot is being collected. It is
        // still important to retain its PID; a missing children file merely
        // means there is no deeper relationship left to discover through it.
        pending.push(...(readProcChildren(pid) ?? []))
    }
    return descendants
}

function readProcChildren(pid: number): number[] | null {
    try {
        const value = readFileSync(
            `/proc/${pid}/task/${pid}/children`,
            "utf8",
        ).trim()
        if (!value) return []
        return value
            .split(/\s+/)
            .map(Number)
            .filter((childPid) =>
                Number.isSafeInteger(childPid) && childPid > 0,
            )
    } catch {
        return null
    }
}

function descendantsFromProcStatuses(rootPid: number): number[] | null {
    let entries: string[]
    try {
        entries = readdirSync("/proc")
    } catch {
        return null
    }

    const parents: Array<readonly [number, number]> = []
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue
        const pid = Number(entry)
        try {
            const status = readFileSync(`/proc/${entry}/status`, "utf8")
            const match = /^PPid:\s+(\d+)\s*$/m.exec(status)
            if (match) parents.push([pid, Number(match[1])])
        } catch {
            // Processes are expected to disappear during a procfs scan.
        }
    }
    return descendantsFromParentPairs(rootPid, parents)
}

function descendantsFromPs(rootPid: number): number[] {
    let output: string
    try {
        output = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 2_000,
        })
    } catch {
        return []
    }

    const parents: Array<readonly [number, number]> = []
    for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (!match) continue
        parents.push([Number(match[1]), Number(match[2])])
    }
    return descendantsFromParentPairs(rootPid, parents)
}

/** Pure parent-table traversal shared by procfs and portable `ps` fallback. */
export function descendantsFromParentPairs(
    rootPid: number,
    parents: ReadonlyArray<readonly [number, number]>,
): number[] {
    const children = new Map<number, number[]>()
    for (const [pid, parent] of parents) {
        const siblings = children.get(parent)
        if (siblings) siblings.push(pid)
        else children.set(parent, [pid])
    }

    const descendants: number[] = []
    const pending = [...(children.get(rootPid) ?? [])]
    const visited = new Set<number>()
    while (pending.length > 0) {
        const pid = pending.shift()!
        if (visited.has(pid)) continue
        visited.add(pid)
        descendants.push(pid)
        pending.push(...(children.get(pid) ?? []))
    }
    return descendants
}
