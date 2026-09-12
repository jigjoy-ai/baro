/**
 * Wall-clock budgets must not count the time a laptop spent asleep. Comparing
 * a wall reading against a monotonic one exposes that gap: only wall time
 * advances across a suspend, so the difference between the two deltas is the
 * sleep. Absorbed gaps are subtracted from every derived deadline, which can
 * only push an expiry later in wall time, never earlier.
 *
 * Imports nothing from this repository so any module may depend on it.
 */

import { performance } from "node:perf_hooks"

export const SUSPENSION_GAP_THRESHOLD_MS = 2_000

/** Deadlines are split into hops so each fire re-checks the clock instead of
 *  trusting a delay that a suspend may have silently absorbed. */
export const AWAKE_SPLIT_MAX_DELAY_MS = 60_000

export type AwakeBudgetName =
    | "architect-phase"
    | "architect-obligations"
    | "architect-round"
    | "board-soft-deadline"
    | "conductor-soft-deadline"
    | "verification-gate"
    | "goal-completion-gate"
    | "goal-review"
    | "exec-file-cli-idle"
    | "exec-file-cli-absolute"
    | "harness-liveness"
    | "cpu-activity"

export interface SuspensionGap {
    readonly gapMs: number
    readonly detectedAtWallMs: number
}

export interface AwakeClock {
    wallNow(): number
    /** Wall time minus every absorbed suspension gap. Never ahead of {@link wallNow}. */
    awakeNow(): number
    absorbedGapMs(): number
    sample(): SuspensionGap | null
    onGapAbsorbed(listener: (gap: SuspensionGap) => void): () => void
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

interface TimeSource {
    wallMs(): number
    monotonicMs(): number
}

interface TimerBackend {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

const REAL_TIMER_BACKEND: TimerBackend = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function createClock(time: TimeSource, timers: TimerBackend): AwakeClock {
    let lastWallMs = time.wallMs()
    let lastMonotonicMs = time.monotonicMs()
    let absorbedMs = 0
    const listeners = new Set<(gap: SuspensionGap) => void>()

    const sample = (): SuspensionGap | null => {
        const wallMs = time.wallMs()
        const monotonicMs = time.monotonicMs()
        const drift = wallMs - lastWallMs - (monotonicMs - lastMonotonicMs)
        lastWallMs = wallMs
        lastMonotonicMs = monotonicMs
        if (drift < SUSPENSION_GAP_THRESHOLD_MS) return null
        // performance.now() is fractional; keep the absorbed total an integer
        // so awake timestamps stay in the same shape as Date.now().
        const gapMs = Math.round(drift)
        absorbedMs += gapMs
        const gap: SuspensionGap = { gapMs, detectedAtWallMs: wallMs }
        for (const listener of [...listeners]) listener(gap)
        return gap
    }

    return {
        wallNow: () => time.wallMs(),
        awakeNow: () => {
            sample()
            // lastWallMs is the reading sample() just took, so awake time can
            // never be derived from a wall instant later than the sample.
            return lastWallMs - absorbedMs
        },
        absorbedGapMs: () => absorbedMs,
        sample,
        onGapAbsorbed: (listener) => {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
        clearTimeout: (handle) => timers.clearTimeout(handle),
    }
}

export function createAwakeClock(): AwakeClock {
    return createClock(
        { wallMs: () => Date.now(), monotonicMs: () => performance.now() },
        REAL_TIMER_BACKEND,
    )
}

let sharedClock: AwakeClock | undefined

export function sharedAwakeClock(): AwakeClock {
    sharedClock ??= createAwakeClock()
    return sharedClock
}

export interface FakeAwakeClock extends AwakeClock {
    /** Moves wall and monotonic together: elapsed awake time, no gap. */
    advance(ms: number): void
    /** Moves wall only: the next sample() sees a suspension gap. */
    suspend(ms: number): void
    runPending(): void
    pendingDelays(): readonly number[]
}

const DEFAULT_FAKE_START_WALL_MS = 1_700_000_000_000

export function createFakeAwakeClock(
    options: { startWallMs?: number } = {},
): FakeAwakeClock {
    let wallMs = options.startWallMs ?? DEFAULT_FAKE_START_WALL_MS
    let monotonicMs = 0
    let nextId = 1

    interface FakeTimer {
        id: number
        dueWallMs: number
        delayMs: number
        callback: () => void
    }
    const pending = new Map<number, FakeTimer>()

    // A real setTimeout that spans a suspend fires on wake, so due-ness is
    // measured in wall time — that is exactly the absorbed-delay hazard the
    // re-checking deadlines have to survive.
    const drain = (): void => {
        for (let guard = 0; ; guard += 1) {
            if (guard > 10_000) {
                throw new Error(
                    "fake awake clock: timer callbacks kept re-arming with a zero delay",
                )
            }
            const due = [...pending.values()]
                .filter((timer) => timer.dueWallMs <= wallMs)
                .sort((a, b) => a.dueWallMs - b.dueWallMs || a.id - b.id)
            if (due.length === 0) return
            for (const timer of due) {
                // An earlier callback in this batch may have cleared this one.
                if (!pending.delete(timer.id)) continue
                timer.callback()
            }
        }
    }

    const clock = createClock(
        { wallMs: () => wallMs, monotonicMs: () => monotonicMs },
        {
            setTimeout: (callback, ms) => {
                const id = nextId++
                const delayMs = Math.max(0, ms)
                pending.set(id, {
                    id,
                    dueWallMs: wallMs + delayMs,
                    delayMs,
                    callback,
                })
                return id
            },
            clearTimeout: (handle) => {
                if (typeof handle === "number") pending.delete(handle)
            },
        },
    )

    return {
        ...clock,
        advance: (ms) => {
            wallMs += ms
            monotonicMs += ms
            drain()
        },
        suspend: (ms) => {
            wallMs += ms
            drain()
        },
        runPending: () => drain(),
        pendingDelays: () => [...pending.values()].map((timer) => timer.delayMs),
    }
}

export interface AwakeDeadline {
    readonly budget: AwakeBudgetName
    readonly timeoutMs: number
    awakeRemainingMs(): number
    expired(): boolean
    close(): void
}

/** Armed deadlines per clock, so an absorbed gap can name the budget it hit.
 *  Keyed by clock because a fake clock's deadlines must never be attributed to
 *  the shared one; read by awake-clock-log.ts, which this file cannot import. */
const armedDeadlines = new WeakMap<AwakeClock, Set<AwakeDeadline>>()

export function armedAwakeDeadlines(clock: AwakeClock): readonly AwakeDeadline[] {
    return [...(armedDeadlines.get(clock) ?? [])]
}

export function createAwakeDeadline(input: {
    budget: AwakeBudgetName
    timeoutMs: number
    onExpired: () => void
    clock?: AwakeClock
}): AwakeDeadline {
    const clock = input.clock ?? sharedAwakeClock()
    const effectiveTimeoutMs = Math.max(1, input.timeoutMs)
    const deadlineAwakeMs = clock.awakeNow() + effectiveTimeoutMs

    let handle: unknown
    let closed = false
    let expiredFired = false

    const awakeRemainingMs = (): number =>
        Math.max(0, deadlineAwakeMs - clock.awakeNow())

    const arm = (): void => {
        handle = clock.setTimeout(
            fire,
            Math.max(0, Math.min(awakeRemainingMs(), AWAKE_SPLIT_MAX_DELAY_MS)),
        )
    }

    function fire(): void {
        handle = undefined
        if (closed) return
        // The armed delay proves nothing: a suspend may have absorbed it. Only
        // a fresh awake reading decides whether the budget is actually spent.
        if (awakeRemainingMs() > 0) {
            arm()
            return
        }
        if (expiredFired) return
        expiredFired = true
        release()
        input.onExpired()
    }

    // Registering here rather than at each adopter is what makes the pairing
    // impossible to forget: a spent or closed handle reports 0 remaining
    // forever and would otherwise own every later gap's attribution.
    function release(): void {
        const armed = armedDeadlines.get(clock)
        if (armed === undefined) return
        armed.delete(deadline)
        if (armed.size === 0) armedDeadlines.delete(clock)
    }

    const deadline: AwakeDeadline = {
        budget: input.budget,
        timeoutMs: input.timeoutMs,
        awakeRemainingMs,
        expired: () => clock.awakeNow() >= deadlineAwakeMs,
        close: () => {
            closed = true
            if (handle !== undefined) clock.clearTimeout(handle)
            handle = undefined
            release()
        },
    }

    const armed = armedDeadlines.get(clock) ?? new Set<AwakeDeadline>()
    armed.add(deadline)
    armedDeadlines.set(clock, armed)
    arm()

    return deadline
}
