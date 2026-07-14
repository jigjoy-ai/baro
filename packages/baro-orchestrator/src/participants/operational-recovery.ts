/**
 * Run-local policy state for incidents that are not evidence of bad code.
 * It is intentionally independent from Surgeon and runtime-DAG adaptation
 * budgets. The Board remains the authority that schedules/cleans work.
 */
export class OperationalRecoveryPolicy {
    private readonly retryAttempts = new Map<string, number>()
    private readonly pendingStories = new Set<string>()
    private readonly routeExclusions = new Map<string, Set<string>>()
    private readonly notBefore = new Map<string, number>()

    constructor(
        private readonly opts: {
            maxRetriesPerStory: number
            marketRouteIds: ReadonlySet<string>
            isRouteUnavailable(routeId: string): boolean
        },
    ) {}

    /** Returns false when the independent retry budget is exhausted. */
    prepare(
        storyId: string,
        options: {
            failedRouteId?: string
            excludeFailedRoute?: boolean
            retryAfterMs?: number
            now?: number
        } = {},
    ): boolean {
        const attempts = this.retryAttempts.get(storyId) ?? 0
        if (attempts >= this.opts.maxRetriesPerStory) {
            this.pendingStories.delete(storyId)
            this.notBefore.delete(storyId)
            return false
        }

        const failedRouteId = options.failedRouteId
        if (
            options.excludeFailedRoute !== false &&
            failedRouteId &&
            this.opts.marketRouteIds.has(failedRouteId)
        ) {
            let excluded = this.routeExclusions.get(storyId)
            if (!excluded) {
                excluded = new Set<string>()
                this.routeExclusions.set(storyId, excluded)
            }
            excluded.add(failedRouteId)
            const hasAlternate = [...this.opts.marketRouteIds].some(
                (routeId) =>
                    !this.opts.isRouteUnavailable(routeId) &&
                    !excluded!.has(routeId),
            )
            // A single-route setup still gets bounded reconnect attempts.
            if (!hasAlternate) excluded.clear()
        }
        const retryAfterMs = finiteNonNegative(options.retryAfterMs)
        if (retryAfterMs > 0) {
            const candidate = (options.now ?? Date.now()) + retryAfterMs
            this.notBefore.set(
                storyId,
                Math.max(this.notBefore.get(storyId) ?? 0, candidate),
            )
        }
        this.pendingStories.add(storyId)
        return true
    }

    isPending(storyId: string): boolean {
        return this.pendingStories.has(storyId)
    }

    isReady(storyId: string, now = Date.now()): boolean {
        return this.pendingStories.has(storyId) &&
            now >= (this.notBefore.get(storyId) ?? 0)
    }

    nextReadyDelay(storyIds: readonly string[], now = Date.now()): number | null {
        let earliest = Number.POSITIVE_INFINITY
        for (const storyId of storyIds) {
            if (!this.pendingStories.has(storyId)) continue
            earliest = Math.min(earliest, this.notBefore.get(storyId) ?? now)
        }
        return Number.isFinite(earliest) ? Math.max(0, earliest - now) : null
    }

    startRetry(storyId: string): number {
        if (!this.isReady(storyId)) {
            throw new Error(`operational retry for ${storyId} started before retry-after`)
        }
        this.pendingStories.delete(storyId)
        this.notBefore.delete(storyId)
        const attempts = (this.retryAttempts.get(storyId) ?? 0) + 1
        this.retryAttempts.set(storyId, attempts)
        return attempts
    }

    attempts(storyId: string): number {
        return this.retryAttempts.get(storyId) ?? 0
    }

    exclusions(storyId: string): readonly string[] {
        return [...(this.routeExclusions.get(storyId) ?? [])]
    }

    abort(storyId: string): void {
        this.pendingStories.delete(storyId)
        this.notBefore.delete(storyId)
    }

    forget(storyId: string): void {
        this.pendingStories.delete(storyId)
        this.retryAttempts.delete(storyId)
        this.routeExclusions.delete(storyId)
        this.notBefore.delete(storyId)
    }
}

function finiteNonNegative(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0
}
