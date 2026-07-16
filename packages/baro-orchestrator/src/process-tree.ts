import type { ChildProcess } from "node:child_process"
import { execFile, execFileSync } from "node:child_process"
import { promises as fs, readdirSync, readFileSync } from "node:fs"

const activeProcessTrees = new Set<ManagedProcessTree>()

const BOOTSTRAP_OBSERVATION_MS = 200
const TERMINATION_OBSERVATION_FLOOR_MS = 100
const STEADY_OBSERVATION_MS = 2_000
const BOOTSTRAP_WINDOW_MS = 2_000

let observationTimer: ReturnType<typeof setTimeout> | null = null
let observationDueAt = Number.POSITIVE_INFINITY
let observationInFlight = false
let observationRerunImmediately = false
let observationScansStarted = 0
let observationScansCompleted = 0
let observationActiveScans = 0
let observationMaxConcurrentScans = 0

type LinuxProcessTableBackend = "proc" | "ps"

// `/proc` start time is boot-relative clock ticks, while `ps lstart` is a
// wall-clock string. They must never be mixed for identity comparison. The
// first successful Linux backend is therefore sticky for the process lifetime.
let linuxProcessTableBackend: LinuxProcessTableBackend | null = null

const TERMINATE_WITH_TABLE = Symbol("terminateWithProcessTable")
const pendingEscalations = new Set<ManagedProcessTree>()
let escalationFlush: ReturnType<typeof setImmediate> | null = null

/**
 * Platform guarantees exposed for diagnostics.
 *
 * Windows `taskkill /T` can terminate a tree only while its root PID still
 * exists. On every platform, a child which has already been re-parented before
 * any process-table snapshot is inherently undiscoverable from the old root
 * PID. Closing that last race requires owning an OS process group or Job
 * Object; this module deliberately does not claim otherwise.
 */
export const PROCESS_TREE_CAPABILITIES = Object.freeze({
    liveRootTreeTermination: true,
    postRootCloseTrackedTermination: process.platform !== "win32",
    postRootCloseUnobservedDescendantDiscovery: false,
    processIdentityValidation:
        process.platform === "linux" || process.platform === "darwin",
})

export interface ProcessIdentitySnapshot {
    pid: number
    startTime: string | null
}

export interface ProcessStateSnapshot extends ProcessIdentitySnapshot {
    parentPid: number
    state: string
}

interface ProcessTable {
    records: Map<number, ProcessStateSnapshot>
    children: Map<number, number[]>
}

export interface ManagedProcessTreeOptions {
    /** Grace between the first soft signal and the mandatory SIGKILL. */
    terminationGraceMs?: number
    /** Requested shared liveness cadence, subject to the process-wide floor. */
    pollIntervalMs?: number
}

export interface ProcessTreeObserverStats {
    scansStarted: number
    scansCompleted: number
    activeScans: number
    maxConcurrentScans: number
}

/** Read-only diagnostics used to verify that discovery never overlaps. */
export function processTreeObserverStats(): ProcessTreeObserverStats {
    return {
        scansStarted: observationScansStarted,
        scansCompleted: observationScansCompleted,
        activeScans: observationActiveScans,
        maxConcurrentScans: observationMaxConcurrentScans,
    }
}

/**
 * Owns the lifecycle of a provider CLI process tree.
 *
 * Provider CLIs are often short-lived npm shims. A single process-wide,
 * asynchronous observer captures their descendants while they are related;
 * each tree then retains identity-checked PIDs through TERM/KILL escalation.
 * There is intentionally no synchronous per-tree polling loop.
 */
export class ManagedProcessTree {
    private readonly terminationGraceMs: number
    private readonly pollIntervalMs: number
    private readonly capturedPids = new Set<number>()
    private readonly identities = new Map<number, ProcessIdentitySnapshot>()
    private readonly rootPid: number | undefined
    private readonly createdAt = Date.now()
    private terminating = false
    private rootClosed = false
    private settled = false
    private escalationTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: () => void

    readonly done: Promise<void>

    constructor(
        private readonly child: ChildProcess,
        options: ManagedProcessTreeOptions = {},
    ) {
        this.terminationGraceMs = options.terminationGraceMs ?? 5_000
        this.pollIntervalMs = options.pollIntervalMs ?? 100
        if (
            !Number.isFinite(this.terminationGraceMs) ||
            this.terminationGraceMs < 1
        ) {
            throw new RangeError(
                "ManagedProcessTree terminationGraceMs must be positive",
            )
        }
        if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 1) {
            throw new RangeError(
                "ManagedProcessTree pollIntervalMs must be positive",
            )
        }

        this.done = new Promise<void>((resolve) => {
            this.resolveDone = resolve
        })
        this.rootPid = child.pid
        activeProcessTrees.add(this)

        // All trees entering during the same turn share this scan. `ps` runs
        // outside the Node event loop, so macOS bootstrap does not block it.
        requestSharedObservation(0)
    }

    /**
     * Request a shared snapshot at a known provider-output boundary. The
     * method remains synchronous to callers; discovery itself is asynchronous.
     */
    refresh(): void {
        if (this.settled) return
        requestSharedObservation(0)
    }

    /**
     * Signal the complete captured tree. A soft signal always schedules
     * SIGKILL, and that schedule survives direct-child `close`.
     */
    terminate(signal: NodeJS.Signals = "SIGTERM"): void {
        this[TERMINATE_WITH_TABLE](signal, readProcessTableSync())
    }

    [TERMINATE_WITH_TABLE](
        signal: NodeJS.Signals,
        table: ProcessTable | null,
    ): void {
        if (this.settled) return
        this.terminating = true

        // Signal delivery is the one latency-sensitive boundary where a
        // synchronous identity-checked snapshot is worthwhile. Routine
        // discovery and liveness checks remain shared and asynchronous.
        this.observe(table)
        this.signalTrackedTree(signal, table)

        if (signal === "SIGKILL") {
            this.clearEscalationTimer()
        } else if (this.escalationTimer === null) {
            this.escalationTimer = setTimeout(() => {
                this.escalationTimer = null
                requestSharedEscalation(this)
            }, this.terminationGraceMs)
        }

        requestSharedObservation(0)
    }

    /**
     * Called at the ChildProcess terminal boundary. The tree waits for the
     * current/next shared snapshot before settling. Only identities delivered
     * before this boundary remain trusted: an in-flight process-table command
     * has no atomic way to prove whether its rows predate root PID reuse.
     */
    markRootClosed(): void {
        if (this.settled) return
        this.rootClosed = true
        requestSharedObservation(0)
    }

    /** Called by the single process-wide observer. */
    observe(table: ProcessTable | null): void {
        if (this.settled || table === null) return

        // Never attach a previously unobserved, already-closed root PID: it
        // may have been recycled. A snapshot delivered before close will have
        // captured the root through an earlier observer turn.
        if (
            !this.rootClosed &&
            this.rootPid !== undefined &&
            !this.identities.has(this.rootPid)
        ) {
            const root = table.records.get(this.rootPid)
            if (root && !isZombie(root.state)) this.capture(root)
        }

        const pending: number[] = []
        for (const identity of this.identities.values()) {
            const record = table.records.get(identity.pid)
            if (observedProcessIsAlive(identity, record)) {
                pending.push(identity.pid)
            }
        }

        const visited = new Set<number>()
        while (pending.length > 0) {
            const parentPid = pending.shift()!
            if (visited.has(parentPid)) continue
            visited.add(parentPid)

            for (const pid of table.children.get(parentPid) ?? []) {
                const record = table.records.get(pid)
                if (!record || isZombie(record.state)) continue
                const existing = this.identities.get(pid)
                if (
                    existing &&
                    existing.startTime !== null &&
                    existing.startTime !== record.startTime
                ) {
                    // PID reuse is accepted only when the new identity is still
                    // demonstrably below a live member of this tree.
                    this.identities.delete(pid)
                    this.capturedPids.delete(pid)
                }
                this.capture(record)
                pending.push(pid)
            }
        }
    }

    /** Internal callback for a completed shared observation. */
    handleObservation(table: ProcessTable | null): void {
        if (this.settled) return
        this.observe(table)

        if (this.terminating) {
            if (!this.hasTrackedProcessAlive(table)) this.settle()
            return
        }

        if (!this.rootClosed) return

        if (this.hasLiveDescendant(table)) {
            this.terminate("SIGTERM")
        } else {
            // If no earlier snapshot observed the relationship, a child which
            // re-parented before this point cannot be reconstructed from the
            // old PID. The exported capability reports this exact boundary.
            this.settle()
        }
    }

    isInBootstrapWindow(now = Date.now()): boolean {
        return now - this.createdAt < BOOTSTRAP_WINDOW_MS
    }

    observationDelay(now = Date.now()): number {
        if (this.terminating || this.rootClosed) {
            return Math.max(
                this.pollIntervalMs,
                TERMINATION_OBSERVATION_FLOOR_MS,
            )
        }
        return this.isInBootstrapWindow(now)
            ? BOOTSTRAP_OBSERVATION_MS
            : STEADY_OBSERVATION_MS
    }

    observerMustKeepEventLoopAlive(): boolean {
        return this.terminating || this.rootClosed
    }

    private capture(record: ProcessStateSnapshot): void {
        this.identities.set(record.pid, {
            pid: record.pid,
            startTime: record.startTime,
        })
        this.capturedPids.add(record.pid)
    }

    private signalTrackedTree(
        signal: NodeJS.Signals,
        table: ProcessTable | null,
    ): void {
        if (process.platform === "win32") {
            // `taskkill /T` is rooted at the raw PID. Once ChildProcess close
            // has confirmed that root is gone, the PID may belong to an
            // unrelated process and must never be reused as authority.
            if (this.rootClosed) return
            const signalled = signalProcessTree(
                this.child,
                signal,
                this.capturedPids,
            )
            for (const pid of signalled) this.capturedPids.add(pid)
            return
        }

        if (table === null) {
            if (this.identities.size > 0) {
                this.signalIdentitiesIndividually(signal)
                return
            }
            // The compatibility helper operates on raw PIDs. It is acceptable
            // only while the actual ChildProcess still claims a live root;
            // after close there is no identity-safe fallback.
            if (
                this.rootClosed ||
                this.child.exitCode !== null ||
                this.child.signalCode !== null
            ) {
                return
            }
            const signalled = signalProcessTree(
                this.child,
                signal,
                this.capturedPids,
            )
            for (const pid of signalled) this.capturedPids.add(pid)
            return
        }

        // A successful table with no captured root identity is authoritative:
        // signalling the raw PID here could target a root which already exited
        // and was recycled before ChildProcess emitted `close`.
        if (this.identities.size === 0) return

        const rootPid = this.rootPid
        const ordered = [...this.identities.values()]
            .filter((identity) =>
                observedProcessIsAlive(
                    identity,
                    table.records.get(identity.pid),
                ),
            )
            .sort(
                (a, b) =>
                    Number(a.pid === rootPid) - Number(b.pid === rootPid),
            )

        for (const identity of ordered) {
            // The single table snapshot supplies both liveness and start-time
            // identity; no per-PID synchronous `ps` subprocess is spawned.
            try {
                process.kill(identity.pid, signal)
            } catch {
                // ESRCH is expected when another member wins the race.
            }
        }
    }

    private signalIdentitiesIndividually(signal: NodeJS.Signals): void {
        const rootPid = this.rootPid
        const ordered = [...this.identities.values()].sort(
            (a, b) => Number(a.pid === rootPid) - Number(b.pid === rootPid),
        )
        for (const identity of ordered) {
            if (!currentIdentityIsAlive(identity)) continue
            try {
                process.kill(identity.pid, signal)
            } catch {
                // The process may exit after validation and before the signal.
            }
        }
    }

    private hasLiveDescendant(table: ProcessTable | null): boolean {
        for (const identity of this.identities.values()) {
            if (identity.pid === this.rootPid) continue
            if (
                table === null
                    ? currentIdentityIsAlive(identity)
                    : observedProcessIsAlive(
                          identity,
                          table.records.get(identity.pid),
                      )
            ) {
                return true
            }
        }
        return false
    }

    private hasTrackedProcessAlive(table: ProcessTable | null): boolean {
        for (const identity of this.identities.values()) {
            if (
                table === null
                    ? currentIdentityIsAlive(identity)
                    : observedProcessIsAlive(
                          identity,
                          table.records.get(identity.pid),
                      )
            ) {
                return true
            }
        }

        // Retain the legacy fallback only when identity capture was entirely
        // unavailable (for example a restricted process table).
        return (
            !this.rootClosed &&
            this.identities.size === 0 &&
            anyProcessAlive(this.capturedPids)
        )
    }

    private clearEscalationTimer(): void {
        if (this.escalationTimer === null) return
        clearTimeout(this.escalationTimer)
        this.escalationTimer = null
    }

    private settle(): void {
        if (this.settled) return
        this.settled = true
        this.clearEscalationTimer()
        pendingEscalations.delete(this)
        if (pendingEscalations.size === 0 && escalationFlush !== null) {
            clearImmediate(escalationFlush)
            escalationFlush = null
        }
        activeProcessTrees.delete(this)
        rescheduleSharedObservation()
        this.resolveDone()
    }
}

function requestSharedEscalation(tree: ManagedProcessTree): void {
    pendingEscalations.add(tree)
    if (escalationFlush !== null) return
    escalationFlush = setImmediate(() => {
        escalationFlush = null
        const trees = [...pendingEscalations]
        pendingEscalations.clear()
        const table = readProcessTableSync()
        for (const pending of trees) {
            pending[TERMINATE_WITH_TABLE]("SIGKILL", table)
        }
    })
}

function requestSharedObservation(delayMs: number): void {
    if (activeProcessTrees.size === 0) return
    if (observationInFlight) {
        if (delayMs <= 0) observationRerunImmediately = true
        return
    }

    const normalizedDelay = Math.max(0, delayMs)
    const dueAt = Date.now() + normalizedDelay
    if (observationTimer !== null && observationDueAt <= dueAt) {
        updateObservationTimerLiveness()
        return
    }

    if (observationTimer !== null) clearTimeout(observationTimer)
    observationDueAt = dueAt
    observationTimer = setTimeout(() => {
        observationTimer = null
        observationDueAt = Number.POSITIVE_INFINITY
        void runSharedObservation()
    }, normalizedDelay)

    updateObservationTimerLiveness()
}

function updateObservationTimerLiveness(): void {
    if (observationTimer === null) return
    if (
        [...activeProcessTrees].some((tree) =>
            tree.observerMustKeepEventLoopAlive(),
        )
    ) {
        observationTimer.ref?.()
    } else {
        observationTimer.unref?.()
    }
}

async function runSharedObservation(): Promise<void> {
    if (observationInFlight) {
        observationRerunImmediately = true
        return
    }
    if (activeProcessTrees.size === 0) return

    observationInFlight = true
    observationScansStarted += 1
    observationActiveScans += 1
    observationMaxConcurrentScans = Math.max(
        observationMaxConcurrentScans,
        observationActiveScans,
    )

    let table: ProcessTable | null = null
    try {
        table = await readProcessTableAsync()
    } catch {
        // A transient observer failure must not break the shared scheduler.
        table = null
    } finally {
        observationScansCompleted += 1
        observationActiveScans -= 1
        observationInFlight = false
    }

    for (const tree of [...activeProcessTrees]) {
        tree.handleObservation(table)
    }

    if (activeProcessTrees.size === 0) {
        observationRerunImmediately = false
        return
    }

    if (observationRerunImmediately) {
        observationRerunImmediately = false
        requestSharedObservation(0)
        return
    }
    rescheduleSharedObservation()
}

function rescheduleSharedObservation(): void {
    if (activeProcessTrees.size === 0) {
        if (observationTimer !== null) clearTimeout(observationTimer)
        observationTimer = null
        observationDueAt = Number.POSITIVE_INFINITY
        return
    }

    const now = Date.now()
    let delay = STEADY_OBSERVATION_MS
    for (const tree of activeProcessTrees) {
        delay = Math.min(delay, tree.observationDelay(now))
    }
    requestSharedObservation(delay)
}

/** Signal every provider tree, including trees whose direct shim has closed. */
export function signalAllProcessTrees(
    signal: NodeJS.Signals = "SIGTERM",
): void {
    const table = readProcessTableSync()
    for (const tree of [...activeProcessTrees]) {
        tree[TERMINATE_WITH_TABLE](signal, table)
    }
}

/** Test/diagnostic visibility without exposing the mutable registry. */
export function activeProcessTreeCount(): number {
    return activeProcessTrees.size
}

/**
 * Signal a child and every descendant visible at the time of the call.
 *
 * This compatibility helper performs a one-time synchronous snapshot. New
 * long-lived participants should prefer ManagedProcessTree, which retains
 * process identities and shares routine observation across every worker.
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
            // The process may have exited between state check and signal.
        }
        return seen
    }

    seen.add(rootPid)

    if (process.platform === "win32") {
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

    // Re-scan every retained PID as well as the root. Between TERM and KILL a
    // provider may launch one last helper below an already captured process.
    const table = readProcessTableSync()
    if (table !== null) {
        const pending = [rootPid, ...seen]
        const visited = new Set<number>()
        while (pending.length > 0) {
            const parentPid = pending.shift()!
            if (visited.has(parentPid)) continue
            visited.add(parentPid)
            for (const pid of table.children.get(parentPid) ?? []) {
                const record = table.records.get(pid)
                if (!record || isZombie(record.state)) continue
                seen.add(pid)
                pending.push(pid)
            }
        }
    }

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
        if (fallbackProcessAlive(pid)) return true
    }
    return false
}

/** Identity-aware liveness: zombies and recycled PIDs are not the same process. */
export function observedProcessIsAlive(
    identity: ProcessIdentitySnapshot,
    observed: ProcessStateSnapshot | undefined,
): boolean {
    if (
        observed === undefined ||
        observed.pid !== identity.pid ||
        isZombie(observed.state)
    ) {
        return false
    }
    return (
        identity.startTime === null ||
        observed.startTime === identity.startTime
    )
}

/**
 * Exceptional per-PID fallback used only when the shared table source failed.
 * It reads the same sticky identity representation which originally captured
 * the process, so a backend failure cannot degrade into raw-PID signalling.
 */
function currentIdentityIsAlive(identity: ProcessIdentitySnapshot): boolean {
    let observed: ProcessStateSnapshot | null
    if (
        process.platform === "linux" &&
        linuxProcessTableBackend === "proc"
    ) {
        observed = readLinuxProcessRecord(identity.pid)
    } else if (
        process.platform === "linux" ||
        process.platform === "darwin"
    ) {
        observed = readPsProcessRecordSync(identity.pid)
    } else {
        return identity.startTime === null && fallbackProcessAlive(identity.pid)
    }
    return observed !== null && observedProcessIsAlive(identity, observed)
}

function fallbackProcessAlive(pid: number): boolean {
    if (process.platform === "linux") {
        const observed = readLinuxProcessRecord(pid)
        if (observed !== null) return !isZombie(observed.state)
    }
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

function isZombie(state: string): boolean {
    return state.trimStart().startsWith("Z")
}

async function readProcessTableAsync(): Promise<ProcessTable | null> {
    if (process.platform === "win32") return null

    if (process.platform === "linux") {
        return readConsistentLinuxProcessTableAsync()
    }

    // `ps` is deliberately asynchronous: on macOS a full table walk commonly
    // takes tens of milliseconds. The shared non-overlapping caller ensures
    // only one such subprocess exists regardless of worker count.
    return readPsProcessTableAsync()
}

function readProcessTableSync(): ProcessTable | null {
    if (process.platform === "win32") return null
    if (process.platform === "linux") return readConsistentLinuxProcessTableSync()
    return readPsProcessTableSync()
}

async function readConsistentLinuxProcessTableAsync(): Promise<ProcessTable | null> {
    if (linuxProcessTableBackend === "proc") {
        return readLinuxProcProcessTableAsync()
    }
    if (linuxProcessTableBackend === "ps") {
        return readPsProcessTableAsync()
    }

    const fromProc = await readLinuxProcProcessTableAsync()
    if (fromProc !== null) {
        if (linuxProcessTableBackend === null) {
            linuxProcessTableBackend = "proc"
        }
        if (linuxProcessTableBackend === "proc") return fromProc
        // A synchronous observation selected `ps` while procfs was in flight.
        return readPsProcessTableAsync()
    }

    // A concurrent synchronous read may already have selected procfs. Never
    // switch its identity representation because one async read failed.
    if ((linuxProcessTableBackend as LinuxProcessTableBackend | null) === "proc") {
        return null
    }
    const fromPs = await readPsProcessTableAsync()
    if (fromPs !== null && linuxProcessTableBackend === null) {
        linuxProcessTableBackend = "ps"
    }
    return linuxProcessTableBackend === "ps" ? fromPs : null
}

function readConsistentLinuxProcessTableSync(): ProcessTable | null {
    if (linuxProcessTableBackend === "proc") {
        return readLinuxProcProcessTable()
    }
    if (linuxProcessTableBackend === "ps") {
        return readPsProcessTableSync()
    }

    const fromProc = readLinuxProcProcessTable()
    if (fromProc !== null) {
        linuxProcessTableBackend = "proc"
        return fromProc
    }
    const fromPs = readPsProcessTableSync()
    if (fromPs !== null) linuxProcessTableBackend = "ps"
    return fromPs
}

function readLinuxProcProcessTable(): ProcessTable | null {
    let entries: string[]
    try {
        entries = readdirSync("/proc")
    } catch {
        return null
    }
    const records: ProcessStateSnapshot[] = []
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue
        const record = readLinuxProcessRecord(Number(entry))
        if (record !== null) records.push(record)
    }
    return buildProcessTable(records)
}

async function readLinuxProcProcessTableAsync(): Promise<ProcessTable | null> {
    let entries: string[]
    try {
        entries = await fs.readdir("/proc")
    } catch {
        return null
    }

    const numericEntries = entries.filter((entry) => /^\d+$/.test(entry))
    const records = await Promise.all(
        numericEntries.map(async (entry) => {
            try {
                return parseLinuxProcStat(
                    await fs.readFile(`/proc/${entry}/stat`, "utf8"),
                )
            } catch {
                return null
            }
        }),
    )
    return buildProcessTable(
        records.filter(
            (record): record is ProcessStateSnapshot => record !== null,
        ),
    )
}

function readLinuxProcessRecord(pid: number): ProcessStateSnapshot | null {
    try {
        return parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
    } catch {
        return null
    }
}

/** Parse `/proc/<pid>/stat`; exported so identity/zombie rules stay testable. */
export function parseLinuxProcStat(value: string): ProcessStateSnapshot | null {
    const open = value.indexOf("(")
    const close = value.lastIndexOf(")")
    if (open < 1 || close <= open) return null
    const pid = Number(value.slice(0, open).trim())
    const fields = value.slice(close + 1).trim().split(/\s+/)
    const parentPid = Number(fields[1])
    const state = fields[0]
    const startTime = fields[19]
    if (
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        !Number.isSafeInteger(parentPid) ||
        parentPid < 0 ||
        typeof state !== "string" ||
        state.length === 0 ||
        typeof startTime !== "string" ||
        startTime.length === 0
    ) {
        return null
    }
    return { pid, parentPid, state, startTime }
}

async function readPsProcessTableAsync(): Promise<ProcessTable | null> {
    return new Promise((resolve) => {
        execFile(
            "ps",
            ["-A", "-o", "pid=,ppid=,state=,lstart="],
            {
                encoding: "utf8",
                timeout: 2_000,
                maxBuffer: 16 * 1024 * 1024,
            },
            (error, stdout) => {
                if (error) {
                    resolve(null)
                    return
                }
                resolve(parsePsProcessTable(String(stdout)))
            },
        )
    })
}

function readPsProcessTableSync(): ProcessTable | null {
    let output: string
    try {
        output = execFileSync(
            "ps",
            ["-A", "-o", "pid=,ppid=,state=,lstart="],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2_000,
                maxBuffer: 16 * 1024 * 1024,
            },
        )
    } catch {
        return null
    }
    return parsePsProcessTable(output)
}

function readPsProcessRecordSync(pid: number): ProcessStateSnapshot | null {
    let output: string
    try {
        output = execFileSync(
            "ps",
            ["-p", String(pid), "-o", "pid=,ppid=,state=,lstart="],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 2_000,
                maxBuffer: 1024 * 1024,
            },
        )
    } catch {
        return null
    }
    return parsePsProcessRecord(output.trim())
}

function parsePsProcessTable(output: string): ProcessTable {
    const records: ProcessStateSnapshot[] = []
    for (const line of output.split("\n")) {
        const record = parsePsProcessRecord(line)
        if (record !== null) records.push(record)
    }
    return buildProcessTable(records)
}

function parsePsProcessRecord(line: string): ProcessStateSnapshot | null {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) return null
    return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        state: match[3],
        startTime: match[4],
    }
}

function buildProcessTable(records: ProcessStateSnapshot[]): ProcessTable {
    const byPid = new Map<number, ProcessStateSnapshot>()
    const children = new Map<number, number[]>()
    for (const record of records) {
        byPid.set(record.pid, record)
        const siblings = children.get(record.parentPid)
        if (siblings) siblings.push(record.pid)
        else children.set(record.parentPid, [record.pid])
    }
    return { records: byPid, children }
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
