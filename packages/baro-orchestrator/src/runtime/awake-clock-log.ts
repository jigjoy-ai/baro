/**
 * The only bridge from absorbed suspension gaps to the event stream.
 * awake-clock.ts stays import-free, so it cannot emit; keeping the
 * subscription here — once per clock — is what makes one absorbed gap
 * produce exactly one line no matter how many budgets were armed.
 */

import { emit } from "../tui-protocol.js"
import { sharedAwakeClock, type AwakeBudgetName, type AwakeClock } from "./awake-clock.js"

/** Enough of an AwakeDeadline to name and rank it; keeps the registry usable
 *  from any adopter without importing the handle's full shape. */
export interface TrackedAwakeBudget {
    readonly budget: AwakeBudgetName
    awakeRemainingMs(): number
}

const trackedBudgets = new Set<TrackedAwakeBudget>()

/**
 * Registers an armed deadline so a gap can name the budget it hit. The clock
 * knows nothing about its adopters, so an unregistered gap is reported as "*".
 */
export function trackAwakeBudget(deadline: TrackedAwakeBudget): () => void {
    trackedBudgets.add(deadline)
    return () => {
        trackedBudgets.delete(deadline)
    }
}

/** The armed budget closest to expiry — the one a gap most endangered. A
 *  handle that is closed or already spent reports 0 remaining forever and
 *  would otherwise win every later attribution, so zero remaining is skipped. */
function affectedBudget(): string {
    let affected: TrackedAwakeBudget | undefined
    for (const tracked of trackedBudgets) {
        const remainingMs = tracked.awakeRemainingMs()
        if (remainingMs <= 0) continue
        if (affected === undefined || remainingMs < affected.awakeRemainingMs()) {
            affected = tracked
        }
    }
    return affected?.budget ?? "*"
}

const installed = new WeakMap<AwakeClock, () => void>()

export function installAwakeGapReporter(
    clock: AwakeClock = sharedAwakeClock(),
): () => void {
    const existing = installed.get(clock)
    if (existing !== undefined) return existing

    const originWallMs = clock.wallNow()
    const originAbsorbedMs = clock.absorbedGapMs()

    const unsubscribe = clock.onGapAbsorbed((gap) => {
        const wallElapsedMs = gap.detectedAtWallMs - originWallMs
        // Derived arithmetically rather than through awakeNow(), which would
        // re-enter the sample() this listener is already running inside.
        const absorbedSinceOriginMs = clock.absorbedGapMs() - originAbsorbedMs
        emit({
            type: "suspension_gap_absorbed",
            gap_ms: gap.gapMs,
            budget: affectedBudget(),
            awake_elapsed_ms: wallElapsedMs - absorbedSinceOriginMs,
            wall_elapsed_ms: wallElapsedMs,
        })
    })

    const uninstall = (): void => {
        installed.delete(clock)
        unsubscribe()
    }
    installed.set(clock, uninstall)
    return uninstall
}
