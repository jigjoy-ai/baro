import type { ChildProcess } from "node:child_process"
import { execFile, execFileSync } from "node:child_process"
import { promises as fs, readdirSync, readFileSync } from "node:fs"
import {
    MAX_PROVIDER_OWNERSHIP_MEMBERS_PER_GROUP,
    providerOwnershipManifestConfigured,
    publishProviderOwnership,
    type ProviderIdentitySource,
    type ProviderOwnershipGroup,
    type ProviderOwnershipPublishResult,
} from "./provider-ownership-manifest.js"

const activeProcessTrees = new Set<ManagedProcessTree>()

const BOOTSTRAP_OBSERVATION_MS = 200
const TERMINATION_OBSERVATION_FLOOR_MS = 100
const STEADY_OBSERVATION_MS = 2_000
const BOOTSTRAP_WINDOW_MS = 2_000
const DEFAULT_QUIESCENCE_TIMEOUT_MS = 2_250
const DEFAULT_NATURAL_EXIT_DRAIN_GRACE_MS = 250

let observationTimer: ReturnType<typeof setTimeout> | null = null
let observationDueAt = Number.POSITIVE_INFINITY
let observationInFlight = false
let observationRerunImmediately = false
let observationScansStarted = 0
let observationScansCompleted = 0
let observationActiveScans = 0
let observationMaxConcurrentScans = 0
let terminalProcessTableCache: { table: ProcessTable | null } | null = null

type LinuxProcessTableBackend = "proc" | "ps"

export const POSIX_PROCESS_GROUPS_SUPPORTED =
    process.platform === "linux" || process.platform === "darwin"

// `/proc` start time is boot-relative clock ticks, while `ps lstart` is a
// wall-clock string. They must never be mixed for identity comparison. The
// first successful Linux backend is therefore sticky for the process lifetime.
let linuxProcessTableBackend: LinuxProcessTableBackend | null = null

const TERMINATE_WITH_TABLE = Symbol("terminateWithProcessTable")
const pendingEscalations = new Set<ManagedProcessTree>()
let escalationFlush: ReturnType<typeof setImmediate> | null = null
let deferOwnershipPublish = false
let ownershipPublishPending = false
let ownershipPublisherForTests:
    | ((groups: readonly ProviderOwnershipGroup[]) => ProviderOwnershipPublishResult)
    | null = null

export type ProcessQuiescenceAssurance = "cooperative-observed" | "none"

export interface ProcessQuiescenceObservation {
    /** `cooperative-observed` is not OS containment: an unobserved daemon can
     * still escape before the first identity snapshot. */
    assurance: ProcessQuiescenceAssurance
    mechanism:
        | "posix-owned-group-plus-identity-table"
        | "uncontained-process-tree"
    groupAbsent: boolean
    trackedAbsent: boolean
}

/**
 * Platform guarantees exposed for diagnostics.
 *
 * Windows `taskkill /T` can terminate a tree only while its root PID still
 * exists. POSIX callers which spawn the root as a detached process-group
 * leader can retain the ordinary in-group provider after its root exits.
 * Identity snapshots also drain descendants observed before they leave that
 * group. This is cooperative observation, not containment: only cgroups,
 * containers, or a Windows Job Object can rule out an unobserved daemon.
 */
export const PROCESS_TREE_CAPABILITIES = Object.freeze({
    liveRootTreeTermination: true,
    postRootCloseTrackedTermination: process.platform !== "win32",
    postRootCloseUnobservedDescendantDiscovery: false,
    ownedProcessGroupTermination: POSIX_PROCESS_GROUPS_SUPPORTED,
    quiescenceAssurance: Object.freeze({
        maximum: POSIX_PROCESS_GROUPS_SUPPORTED
            ? "cooperative-observed" as const
            : "none" as const,
        mechanism: POSIX_PROCESS_GROUPS_SUPPORTED
            ? "posix-owned-group-plus-identity-table" as const
            : "uncontained-process-tree" as const,
        rulesOutUnobservedDetachedDescendants: false,
    }),
    /** Boolean convenience for the scoped structured assurance above. */
    cooperativeQuiescenceObservation:
        POSIX_PROCESS_GROUPS_SUPPORTED,
    processIdentityValidation:
        process.platform === "linux" || process.platform === "darwin",
})

export interface ProcessIdentitySnapshot {
    pid: number
    startTime: string | null
}

export interface ProcessStateSnapshot extends ProcessIdentitySnapshot {
    parentPid: number
    processGroupId: number
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
    /**
     * The child was spawned as the leader of a new POSIX process group.
     * Ignored on platforms where negative-PID group signals are unsupported.
     */
    ownsProcessGroup?: boolean
    /** Maximum post-SIGKILL wait for a positive process-table certificate. */
    quiescenceTimeoutMs?: number
    /**
     * Bounded grace for an owned helper to flush inherited stdio after its
     * direct CLI root exits naturally. Explicit termination bypasses it.
     */
    naturalExitDrainGraceMs?: number
    /** @internal Deterministic process-table failure seam for tests. */
    processGroupObservation?: (
        processGroupId: number,
        records: Iterable<ProcessStateSnapshot> | null,
    ) => boolean | null
}

export interface ProcessTreeObserverStats {
    scansStarted: number
    scansCompleted: number
    activeScans: number
    maxConcurrentScans: number
}

/** @internal Deterministic ownership-publication failure seam. The active-tree
 * guard keeps one test from changing the crash boundary underneath another. */
export function setProcessTreeOwnershipPublisherForTests(
    publisher:
        | ((
              groups: readonly ProviderOwnershipGroup[],
          ) => ProviderOwnershipPublishResult)
        | null,
): void {
    if (activeProcessTrees.size > 0) {
        throw new Error(
            "cannot replace process-tree ownership publisher while trees are active",
        )
    }
    ownershipPublisherForTests = publisher
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
    private readonly quiescenceTimeoutMs: number
    private readonly naturalExitDrainGraceMs: number
    private readonly processGroupObservation: NonNullable<
        ManagedProcessTreeOptions["processGroupObservation"]
    >
    private readonly capturedPids = new Set<number>()
    private readonly identities = new Map<number, ProcessIdentitySnapshot>()
    private readonly rootPid: number | undefined
    private readonly ownedProcessGroupId: number | null
    private readonly ownedGroupMembers = new Map<
        number,
        ProcessIdentitySnapshot
    >()
    /** Live identity-captured members grouped by their actual PGID, including
     * observed descendants which escaped the original owned group. */
    private readonly trackedGroupMembers = new Map<
        number,
        Map<number, ProcessIdentitySnapshot>
    >()
    private ownedGroupIdentitySource: ProviderIdentitySource | null = null
    private ownershipManifestRegistered = false
    private ownershipRegistrationFailed = false
    /** Exact live membership represented by the last durable manifest
     * generation. A mismatch means crash recovery has not caught up yet. */
    private publishedOwnershipFingerprint: string | null = null
    private readonly createdAt = Date.now()
    private terminating = false
    private rootClosed = false
    private naturalExitDrainUntil = 0
    private settled = false
    private escalationTimer: ReturnType<typeof setTimeout> | null = null
    private quiescenceTimer: ReturnType<typeof setTimeout> | null = null
    private resolveDone!: () => void
    private resolveQuiescence!: (certified: boolean) => void
    private resolveQuiescenceObservation!: (
        observation: ProcessQuiescenceObservation,
    ) => void

    readonly done: Promise<void>
    /**
     * Resolves true only after an authoritative process-table snapshot finds
     * no live member of this tree's owned POSIX process group and no live
     * identity-captured descendant which escaped that group. Legacy trees,
     * Windows trees, and unsupported platforms resolve false when they settle.
     * An unobserved daemon remains outside this cooperative POSIX assurance;
     * only an OS containment primitive can rule that case out completely.
     */
    readonly quiescence: Promise<boolean>
    /** Structured, honest scope of the same terminal observation. */
    readonly quiescenceObservation: Promise<ProcessQuiescenceObservation>

    constructor(
        private readonly child: ChildProcess,
        options: ManagedProcessTreeOptions = {},
    ) {
        this.terminationGraceMs = options.terminationGraceMs ?? 5_000
        this.pollIntervalMs = options.pollIntervalMs ?? 100
        this.quiescenceTimeoutMs =
            options.quiescenceTimeoutMs ?? DEFAULT_QUIESCENCE_TIMEOUT_MS
        this.naturalExitDrainGraceMs =
            options.naturalExitDrainGraceMs ??
            DEFAULT_NATURAL_EXIT_DRAIN_GRACE_MS
        this.processGroupObservation =
            options.processGroupObservation ?? observedProcessGroupIsAlive
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
        if (
            !Number.isFinite(this.quiescenceTimeoutMs) ||
            this.quiescenceTimeoutMs < 1
        ) {
            throw new RangeError(
                "ManagedProcessTree quiescenceTimeoutMs must be positive",
            )
        }
        if (
            !Number.isFinite(this.naturalExitDrainGraceMs) ||
            this.naturalExitDrainGraceMs < 0
        ) {
            throw new RangeError(
                "ManagedProcessTree naturalExitDrainGraceMs must be non-negative",
            )
        }

        this.done = new Promise<void>((resolve) => {
            this.resolveDone = resolve
        })
        this.rootPid = child.pid
        this.ownedProcessGroupId =
            options.ownsProcessGroup === true &&
            POSIX_PROCESS_GROUPS_SUPPORTED &&
            this.rootPid !== undefined &&
            Number.isSafeInteger(this.rootPid) &&
            this.rootPid > 0
                ? this.rootPid
                : null
        this.quiescence = new Promise<boolean>((resolve) => {
            this.resolveQuiescence = resolve
        })
        this.quiescenceObservation =
            new Promise<ProcessQuiescenceObservation>((resolve) => {
                this.resolveQuiescenceObservation = resolve
            })
        activeProcessTrees.add(this)

        // Registration is synchronous so a host TERM immediately after spawn
        // cannot miss a newly detached provider group.
        if (
            this.ownedProcessGroupId !== null &&
            processTreeOwnershipManifestConfigured()
        ) {
            const rootTable = readRootProcessTableSync(this.rootPid)
            this.observe(rootTable)
            const publication = publishActiveProviderOwnership()
            if (!this.ownershipManifestRegistered) {
                const reason =
                    publication !== null && !publication.ok
                        ? publication.error
                        : "provider identity was unavailable for the complete ownership snapshot"
                this.failClosedOwnershipRegistration(reason, rootTable)
            }
        }

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

    /** Signal the tree and await a truthful OS-level quiescence verdict. */
    terminateAndWait(
        signal: NodeJS.Signals = "SIGTERM",
    ): Promise<boolean> {
        this.terminate(signal)
        // Unsupported/unowned trees cannot earn a positive certificate, but
        // `AndWait` must preserve the legacy drain barrier before returning
        // false (not let a timeout/retry race the still-closing child).
        if (this.ownedProcessGroupId === null) {
            return this.done.then(() => false)
        }
        return this.quiescence
    }

    /** Signal the tree and return the exact scope Baro actually observed. */
    terminateAndObserve(
        signal: NodeJS.Signals = "SIGTERM",
    ): Promise<ProcessQuiescenceObservation> {
        this.terminate(signal)
        return this.quiescenceObservation
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
        publishActiveProviderOwnership()
        this.signalTrackedTree(signal, table)

        if (signal === "SIGKILL") {
            this.clearEscalationTimer()
            this.startQuiescenceDeadline()
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
     * current/next shared snapshot before settling. A synchronous same-turn
     * group snapshot closes the fast-shim handoff gap; later in-flight async
     * rows still cannot introduce identities at this terminal boundary.
     */
    markRootClosed(): void {
        if (this.settled || this.rootClosed) return
        // Capture a same-turn full snapshot before yielding. A short-lived
        // executable shim may already be gone while its real provider remains
        // in the owned group; waiting for the async observer would leave only
        // the dead shim identity in Rust's crash-recovery manifest. Concurrent
        // terminal callbacks share this one bounded table read.
        const table =
            this.ownedProcessGroupId === null
                ? null
                : readTerminalProcessTableSync()
        if (this.ownedProcessGroupId !== null) {
            this.observe(table)
            if (table !== null) this.captureOwnedGroupMembers(table, true)
        }
        const groupAlive =
            this.ownedProcessGroupId === null
                ? null
                : this.observeOwnedProcessGroup(table)
        this.rootClosed = true
        const trackedAlive = this.hasTrackedProcessAlive(table)
        if (groupAlive === false && !trackedAlive) {
            // The terminal snapshot itself certifies that the owned group is
            // empty and every identity-captured escape is gone. This is the
            // ordinary successful one-shot path, not an ownership-registration
            // failure, and no stale PGID is signalled.
            this.settle(true)
            return
        }
        if (
            (groupAlive === true || trackedAlive) &&
            this.ownedProcessGroupId !== null &&
            processTreeOwnershipManifestConfigured()
        ) {
            const publication = publishActiveProviderOwnership()
            if (
                this.ownershipSnapshots() === null ||
                publication === null ||
                !publication.ok
            ) {
                const reason =
                    publication !== null && !publication.ok
                        ? publication.error
                        : "the provider shim exited before a live group identity could be durably published"
                this.failClosedOwnershipRegistration(reason, table)
            }
        }
        this.naturalExitDrainUntil =
            Date.now() + this.naturalExitDrainGraceMs
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

        // A detached executable may be only a short-lived shim. The OS can
        // reap that root before Node delivers its `close` callback, while the
        // real provider is already reparented and therefore no longer
        // discoverable through ancestry. Until that terminal callback, the
        // exact process group still belongs to this spawned root, so retain
        // every live identity in it. After `rootClosed`, only previously
        // captured identities may extend the tracked set; that avoids later
        // attaching to a numerically reused process group.
        this.captureOwnedGroupMembers(
            table,
            !this.rootClosed &&
                this.child.exitCode === null &&
                this.child.signalCode === null,
        )
    }

    /** Internal callback for a completed shared observation. */
    handleObservation(table: ProcessTable | null): void {
        if (this.settled) return
        this.observe(table)

        if (this.ownedProcessGroupId !== null) {
            const groupAlive = this.observeOwnedProcessGroup(table)
            const trackedAlive = this.hasTrackedProcessAlive(table)

            // Unknown is deliberately not absence. Keep ownership and retry;
            // neither `done` nor the positive certification may settle from a
            // failed/restricted process-table read.
            if (groupAlive === null) {
                // Root close proves the provider leader is gone, so group
                // signalling is safe even though enumeration failed. This
                // also starts the bounded TERM/KILL fail-closed deadline.
                if (this.rootClosed && !this.terminating) {
                    if (this.naturalExitDrainPending()) return
                    this.terminate("SIGTERM")
                }
                return
            }

            if (this.terminating) {
                if (!groupAlive && !trackedAlive) this.settle(true)
                return
            }

            if (!this.rootClosed) return
            if (groupAlive || trackedAlive) {
                if (this.naturalExitDrainPending()) return
                this.terminate("SIGTERM")
            } else this.settle(true)
            return
        }

        if (this.terminating) {
            if (!this.hasTrackedProcessAlive(table)) this.settle()
            return
        }

        if (!this.rootClosed) return

        if (this.hasLiveDescendant(table)) {
            if (this.naturalExitDrainPending()) return
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

    private naturalExitDrainPending(now = Date.now()): boolean {
        return (
            this.rootClosed &&
            !this.terminating &&
            now < this.naturalExitDrainUntil
        )
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
        if (this.ownedProcessGroupId !== null) {
            const rootStillAnchorsGroup =
                !this.rootClosed &&
                this.child.exitCode === null &&
                this.child.signalCode === null
            if (
                rootStillAnchorsGroup ||
                this.hasOwnedGroupIdentityInTable(table)
            ) {
                try {
                    process.kill(-this.ownedProcessGroupId, signal)
                } catch {
                    // ESRCH is expected when the group exits between
                    // observation and delivery. Absence is certified by a
                    // later table, never inferred from this signal call.
                }
            }
            // A provider can call setsid/setpgid and leave the root's group.
            // Retained PID/start-time identities remain authority for those
            // observed descendants and must be drained before certification.
            this.signalTrackedProcessesOutsideOwnedGroup(signal, table)
            return
        }

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

    private signalTrackedProcessesOutsideOwnedGroup(
        signal: NodeJS.Signals,
        table: ProcessTable | null,
    ): void {
        for (const identity of this.identities.values()) {
            const observed = table?.records.get(identity.pid)
            if (table !== null) {
                if (!observedProcessIsAlive(identity, observed)) continue
                if (
                    observed?.processGroupId === this.ownedProcessGroupId
                ) continue
            } else if (!currentIdentityIsAlive(identity)) {
                continue
            }
            try {
                process.kill(identity.pid, signal)
            } catch {
                // The identity may exit after validation and before delivery.
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

    private observeOwnedProcessGroup(
        table: ProcessTable | null,
    ): boolean | null {
        if (this.ownedProcessGroupId === null) return null
        try {
            return this.processGroupObservation(
                this.ownedProcessGroupId,
                table === null ? null : table.records.values(),
            )
        } catch {
            return null
        }
    }

    private hasOwnedGroupIdentityInTable(table: ProcessTable | null): boolean {
        if (table === null || this.ownedProcessGroupId === null) return false
        for (const identity of this.ownedGroupMembers.values()) {
            const observed = table.records.get(identity.pid)
            if (
                observed?.processGroupId === this.ownedProcessGroupId &&
                observedProcessIsAlive(identity, observed)
            ) {
                return true
            }
        }
        return false
    }

    private startQuiescenceDeadline(): void {
        if (
            this.ownedProcessGroupId === null ||
            this.quiescenceTimer !== null ||
            this.settled
        ) {
            return
        }
        this.quiescenceTimer = setTimeout(() => {
            this.quiescenceTimer = null
            if (this.settled) return

            // Observers have had a bounded post-KILL window. A final unknown
            // or still-live result is an explicit negative verdict, never a
            // fabricated certificate. Settling also releases all ref'ed
            // observer/timer resources.
            const table = readProcessTableSync()
            this.observe(table)
            const groupAlive = this.observeOwnedProcessGroup(table)
            const trackedAlive = this.hasTrackedProcessAlive(table)
            const groupAbsent = groupAlive === false
            const trackedAbsent = !trackedAlive
            this.settle(
                groupAbsent && trackedAbsent,
                groupAbsent,
                trackedAbsent,
            )
        }, this.quiescenceTimeoutMs)
    }

    private clearQuiescenceTimer(): void {
        if (this.quiescenceTimer === null) return
        clearTimeout(this.quiescenceTimer)
        this.quiescenceTimer = null
    }

    private settle(
        quiescenceObserved = false,
        groupAbsent = quiescenceObserved,
        trackedAbsent = quiescenceObserved,
    ): void {
        if (this.settled) return
        this.settled = true
        this.clearEscalationTimer()
        this.clearQuiescenceTimer()
        pendingEscalations.delete(this)
        if (pendingEscalations.size === 0 && escalationFlush !== null) {
            clearImmediate(escalationFlush)
            escalationFlush = null
        }
        activeProcessTrees.delete(this)
        publishActiveProviderOwnership()
        rescheduleSharedObservation()
        const observation: ProcessQuiescenceObservation = {
            assurance: quiescenceObserved
                ? "cooperative-observed"
                : "none",
            mechanism:
                this.ownedProcessGroupId !== null
                    ? "posix-owned-group-plus-identity-table"
                    : "uncontained-process-tree",
            groupAbsent,
            trackedAbsent,
        }
        this.resolveQuiescence(quiescenceObserved)
        this.resolveQuiescenceObservation(observation)
        this.resolveDone()
    }

    ownershipSnapshots(): ProviderOwnershipGroup[] | null {
        if (
            this.ownedProcessGroupId === null ||
            this.ownedGroupIdentitySource === null ||
            this.trackedGroupMembers.size === 0
        ) {
            return null
        }
        return [...this.trackedGroupMembers]
            .sort(([left], [right]) => left - right)
            .map(([processGroupId, members]) => ({
                processGroupId,
                identitySource: this.ownedGroupIdentitySource!,
                members: [...members.values()]
                    .sort((left, right) => left.pid - right.pid)
                    .map((member) => ({
                        pid: member.pid,
                        startTime: member.startTime ?? "",
                    })),
            }))
    }

    requiresOwnershipManifestEntry(): boolean {
        return this.ownedProcessGroupId !== null
    }

    /** True when spawn returned a concrete provider PID, on any platform. */
    hasSpawnedRootProcess(): boolean {
        return this.rootPid !== undefined &&
            Number.isSafeInteger(this.rootPid) &&
            this.rootPid > 0
    }

    markOwnershipManifestRegistered(): void {
        this.ownershipManifestRegistered = true
        this.publishedOwnershipFingerprint =
            this.currentOwnershipFingerprint()
    }

    /** Stop only a tree whose newly observed membership is absent from the
     * last durable manifest. Called after the shared batch publish returns, so
     * this path must not attempt another publication recursively. */
    failClosedUnpublishedOwnershipMembership(
        reason: string,
        validatedTable: ProcessTable | null,
    ): void {
        if (
            this.ownershipRegistrationFailed ||
            !this.hasUnpublishedOwnershipMembership()
        ) {
            return
        }
        this.failClosedOwnershipRegistration(
            `updated provider membership could not be durably published: ${reason}`,
            validatedTable,
        )
    }

    private currentOwnershipFingerprint(): string | null {
        const groups = this.ownershipSnapshots()
        return groups === null ? null : JSON.stringify(groups)
    }

    private hasUnpublishedOwnershipMembership(): boolean {
        return (
            this.currentOwnershipFingerprint() !==
            this.publishedOwnershipFingerprint
        )
    }

    private failClosedOwnershipRegistration(
        reason: string,
        validatedTable: ProcessTable | null = readProcessTableSync(),
    ): void {
        if (
            this.ownershipRegistrationFailed ||
            this.ownedProcessGroupId === null ||
            this.settled
        ) {
            return
        }
        this.ownershipRegistrationFailed = true
        process.emitWarning(
            `Provider process group ${this.ownedProcessGroupId} was killed because Baro could not register its ownership: ${reason}`,
            { code: "BARO_PROVIDER_OWNERSHIP_REGISTRATION_FAILED" },
        )

        // This group was created by this exact ChildProcess and has not been
        // admitted to the durable manifest. Kill it immediately; allowing an
        // unregistered detached provider to continue would defeat Rust's
        // crash/OOM cleanup boundary.
        this.terminating = true
        this.observe(validatedTable)
        this.signalTrackedTree("SIGKILL", validatedTable)
        this.startQuiescenceDeadline()
        requestSharedObservation(0)
    }

    private captureOwnedGroupMembers(
        table: ProcessTable,
        includeUntrackedGroupMembers = false,
    ): void {
        if (this.ownedProcessGroupId === null) return
        const identitySource = processIdentitySource()
        if (identitySource === null) return

        if (includeUntrackedGroupMembers) {
            for (const record of table.records.values()) {
                if (
                    record.processGroupId === this.ownedProcessGroupId &&
                    !isZombie(record.state) &&
                    record.startTime !== null
                ) {
                    this.capture(record)
                }
            }
        }
        this.ownedGroupMembers.clear()
        this.trackedGroupMembers.clear()
        for (const identity of this.identities.values()) {
            const record = table.records.get(identity.pid)
            if (
                !observedProcessIsAlive(identity, record) ||
                record === undefined ||
                record.processGroupId < 2 ||
                record.startTime === null
            ) {
                continue
            }
            this.ownedGroupIdentitySource = identitySource
            const group =
                this.trackedGroupMembers.get(record.processGroupId) ??
                new Map<number, ProcessIdentitySnapshot>()
            if (
                group.size < MAX_PROVIDER_OWNERSHIP_MEMBERS_PER_GROUP
            ) {
                group.set(record.pid, {
                    pid: record.pid,
                    startTime: record.startTime,
                })
                this.trackedGroupMembers.set(record.processGroupId, group)
            }
            if (record.processGroupId !== this.ownedProcessGroupId) continue
            this.ownedGroupMembers.set(record.pid, {
                pid: record.pid,
                startTime: record.startTime,
            })
        }
    }
}

function publishActiveProviderOwnership(): ProviderOwnershipPublishResult | null {
    if (!processTreeOwnershipManifestConfigured()) return null
    if (deferOwnershipPublish) {
        ownershipPublishPending = true
        return null
    }
    ownershipPublishPending = false
    const entries: Array<{
        tree: ManagedProcessTree
        group: ProviderOwnershipGroup
    }> = []
    for (const tree of activeProcessTrees) {
        if (!tree.requiresOwnershipManifestEntry()) continue
        const groups = tree.ownershipSnapshots()
        if (groups === null) {
            // Preserve the last complete generation. The caller which owns a
            // newly spawned tree will fail it closed; already registered trees
            // remain represented by the previous generation.
            return {
                ok: false,
                error: "an active provider group has no identity-safe ownership snapshot",
            }
        }
        for (const group of groups) entries.push({ tree, group })
    }
    const result = (ownershipPublisherForTests ?? publishProviderOwnership)(
        entries.map(({ group }) => group),
    )
    if (result.ok) {
        for (const { tree } of entries) {
            tree.markOwnershipManifestRegistered()
        }
    }
    return result
}

function processTreeOwnershipManifestConfigured(): boolean {
    return (
        ownershipPublisherForTests !== null ||
        providerOwnershipManifestConfigured()
    )
}

function processIdentitySource(): ProviderIdentitySource | null {
    if (process.platform === "darwin") return "posix-ps-lstart-v1"
    if (process.platform !== "linux") return null
    return linuxProcessTableBackend === "proc"
        ? "linux-proc-stat-v1"
        : linuxProcessTableBackend === "ps"
          ? "posix-ps-lstart-v1"
          : null
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

    // A process table is a point-in-time observation of exactly the trees
    // which existed when its read began. A new tree can be constructed while
    // an asynchronous `ps` scan is in flight; applying that pre-spawn table to
    // it would erase the synchronously registered root identity and trigger a
    // false ownership failure. Its constructor requests an immediate rerun,
    // so leave it for that fresh observation instead.
    const observedTrees = [...activeProcessTrees]
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

    deferOwnershipPublish = true
    try {
        for (const tree of observedTrees) {
            if (!activeProcessTrees.has(tree)) continue
            tree.handleObservation(table)
        }
    } finally {
        deferOwnershipPublish = false
    }
    if (ownershipPublishPending || activeProcessTrees.size > 0) {
        const publication = publishActiveProviderOwnership()
        if (publication !== null && !publication.ok) {
            // The last durable generation still protects unchanged trees. Kill
            // only trees whose newly observed membership is missing from it.
            // This direct fail-closed path deliberately does not publish again;
            // the next ordinary observer turn will serialize the drained set.
            for (const tree of [...activeProcessTrees]) {
                tree.failClosedUnpublishedOwnershipMembership(
                    publication.error,
                    table,
                )
            }
        }
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
 * Tri-state process-group liveness from one authoritative snapshot.
 * `null` is intentionally preserved so callers can never turn an observation
 * failure into a positive quiescence certificate.
 */
export function observedProcessGroupIsAlive(
    processGroupId: number,
    observed: Iterable<ProcessStateSnapshot> | null,
): boolean | null {
    if (observed === null) return null
    for (const record of observed) {
        if (
            record.processGroupId === processGroupId &&
            !isZombie(record.state)
        ) {
            return true
        }
    }
    return false
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

function readTerminalProcessTableSync(): ProcessTable | null {
    if (terminalProcessTableCache !== null) {
        return terminalProcessTableCache.table
    }
    terminalProcessTableCache = { table: readProcessTableSync() }
    const clear = setImmediate(() => {
        terminalProcessTableCache = null
    })
    clear.unref?.()
    return terminalProcessTableCache.table
}

function readRootProcessTableSync(rootPid: number | undefined): ProcessTable | null {
    if (rootPid === undefined || process.platform === "win32") return null
    let record: ProcessStateSnapshot | null = null
    if (process.platform === "linux") {
        if (linuxProcessTableBackend === "ps") {
            record = readPsProcessRecordSync(rootPid)
        } else {
            record = readLinuxProcessRecord(rootPid)
            if (record !== null) linuxProcessTableBackend = "proc"
            else if (linuxProcessTableBackend === null) {
                record = readPsProcessRecordSync(rootPid)
                if (record !== null) linuxProcessTableBackend = "ps"
            }
        }
    } else if (process.platform === "darwin") {
        record = readPsProcessRecordSync(rootPid)
    }
    return record === null ? null : buildProcessTable([record])
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
    return records.length === 0 ? null : buildProcessTable(records)
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
    const observed = records.filter(
        (record): record is ProcessStateSnapshot => record !== null,
    )
    return observed.length === 0 ? null : buildProcessTable(observed)
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
    const processGroupId = Number(fields[2])
    const state = fields[0]
    const startTime = fields[19]
    if (
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        !Number.isSafeInteger(parentPid) ||
        parentPid < 0 ||
        !Number.isSafeInteger(processGroupId) ||
        processGroupId < 1 ||
        typeof state !== "string" ||
        state.length === 0 ||
        typeof startTime !== "string" ||
        startTime.length === 0
    ) {
        return null
    }
    return { pid, parentPid, processGroupId, state, startTime }
}

async function readPsProcessTableAsync(): Promise<ProcessTable | null> {
    return new Promise((resolve) => {
        execFile(
            "ps",
            ["-A", "-o", "pid=,ppid=,pgid=,state=,lstart="],
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
            ["-A", "-o", "pid=,ppid=,pgid=,state=,lstart="],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 500,
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
            [
                "-p",
                String(pid),
                "-o",
                "pid=,ppid=,pgid=,state=,lstart=",
            ],
            {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 250,
                maxBuffer: 1024 * 1024,
            },
        )
    } catch {
        return null
    }
    return parsePsProcessRecord(output.trim())
}

function parsePsProcessTable(output: string): ProcessTable | null {
    const records: ProcessStateSnapshot[] = []
    for (const line of output.split("\n")) {
        if (line.trim().length === 0) continue
        const record = parsePsProcessRecord(line)
        if (record === null) return null
        records.push(record)
    }
    return records.length === 0 ? null : buildProcessTable(records)
}

function parsePsProcessRecord(line: string): ProcessStateSnapshot | null {
    const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) return null
    return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        state: match[4],
        startTime: match[5],
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
