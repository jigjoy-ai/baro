import type {
    CritiqueData,
    StoryFailureData,
} from "../semantic-events.js"

export type TurnReviewWaitResult =
    | { kind: "review"; review: CritiqueData }
    | { kind: "timeout" }
    | { kind: "cancelled" }

export interface TurnReviewFailure {
    error: string
    failure: StoryFailureData
}

export type TurnReviewDisposition =
    | { kind: "pass" }
    /** Execution may close, but AcceptanceGate still owns integration and
     * must re-evaluate this unchanged candidate. This is not a semantic pass. */
    | { kind: "handoff" }
    | { kind: "revise"; feedback: string }
    | ({ kind: "failure" } & TurnReviewFailure)

export interface StreamingTurnLifecycleOptions {
    requiresReview: boolean
    maxTurns: number
    quietTimeoutMs: number
    reviewTimeoutMs: number
    /** Collective-only: an external AcceptanceGate remains the final quality
     * authority and can recheck an inconclusive terminal after execution ends. */
    handoffInconclusiveToAcceptanceGate?: boolean
    onFinish(): void
    onRevision(feedback: string, review: CritiqueData): void
    revisionFailure(error: unknown): TurnReviewFailure
}

interface ActiveTurnReviewWait {
    terminalId: string
    finish(result: TurnReviewWaitResult): void
}

/**
 * Correlated, race-safe mailbox for authoritative terminal-turn reviews.
 * Authority and agent-id checks deliberately stay at each participant's bus
 * boundary; this class only snapshots already-authorized payloads and owns
 * one bounded active wait.
 */
export class TurnReviewMailbox {
    private readonly queued = new Map<string, CritiqueData>()
    private active: ActiveTurnReviewWait | null = null

    deliver(review: CritiqueData): void {
        const terminalId = review.terminalId
        if (!terminalId) return
        const snapshot = snapshotTurnReview(review)
        if (this.active?.terminalId === terminalId) {
            this.active.finish({ kind: "review", review: snapshot })
            return
        }
        // One authoritative verdict exists per terminal. Preserve the legacy
        // last-write-wins behavior for duplicate early delivery/replay.
        this.queued.set(terminalId, snapshot)
    }

    waitFor(
        terminalId: string,
        options: { timeoutMs: number; signal?: AbortSignal },
    ): Promise<TurnReviewWaitResult> {
        if (this.active) {
            throw new Error(
                `already waiting for terminal review ${this.active.terminalId}`,
            )
        }
        const queued = this.dequeue(terminalId)
        if (queued) return Promise.resolve({ kind: "review", review: queued })

        return new Promise<TurnReviewWaitResult>((resolve) => {
            const signal = options.signal
            let settled = false
            let timer: ReturnType<typeof setTimeout> | null = null
            let wait: ActiveTurnReviewWait
            const finish = (result: TurnReviewWaitResult) => {
                if (settled) return
                settled = true
                if (timer) clearTimeout(timer)
                signal?.removeEventListener("abort", onAbort)
                if (this.active === wait) this.active = null
                resolve(result)
            }
            const onAbort = () => finish({ kind: "cancelled" })
            wait = { terminalId, finish }
            this.active = wait
            timer = setTimeout(
                () => finish({ kind: "timeout" }),
                options.timeoutMs,
            )

            // Close the registration race: delivery may have queued after
            // the first lookup but before the active wait became visible.
            const raced = this.dequeue(terminalId)
            if (raced) finish({ kind: "review", review: raced })
            else if (signal?.aborted) finish({ kind: "cancelled" })
            else signal?.addEventListener("abort", onAbort, { once: true })
        })
    }

    cancelActive(): void {
        this.active?.finish({ kind: "cancelled" })
    }

    private dequeue(terminalId: string): CritiqueData | undefined {
        const review = this.queued.get(terminalId)
        this.queued.delete(terminalId)
        return review
    }
}

/** Race-safe FIFO used for ordinary corrective messages between turns. */
export class TurnMessageMailbox<T> {
    private readonly queued: T[] = []
    private active: ((item: T | null) => void) | null = null

    deliver(item: T): void {
        this.queued.push(item)
        if (this.active) this.active(this.queued.shift()!)
    }

    waitForNext(options: {
        timeoutMs: number
        signal?: AbortSignal
    }): Promise<T | null> {
        if (this.queued.length > 0) return Promise.resolve(this.queued.shift()!)
        if (this.active) throw new Error("already waiting for the next turn message")

        return new Promise<T | null>((resolve) => {
            const signal = options.signal
            let settled = false
            let timer: ReturnType<typeof setTimeout> | null = null
            const finish = (item: T | null) => {
                if (settled) return
                settled = true
                if (timer) clearTimeout(timer)
                signal?.removeEventListener("abort", onAbort)
                if (this.active === finish) this.active = null
                resolve(item)
            }
            const onAbort = () => finish(null)
            this.active = finish
            timer = setTimeout(() => finish(null), options.timeoutMs)

            // Close the same registration race as the correlated mailbox.
            if (this.queued.length > 0) finish(this.queued.shift()!)
            else if (signal?.aborted) finish(null)
            else signal?.addEventListener("abort", onAbort, { once: true })
        })
    }
}

/** Event-driven lifecycle for stream-json backends that stay open between turns. */
export class StreamingTurnLifecycle {
    private readonly reviews = new TurnReviewMailbox()
    private turnsObserved = 0
    private quietTimer: ReturnType<typeof setTimeout> | null = null
    private waitingTerminalId: string | null = null
    private reviewFailure: TurnReviewFailure | null = null
    private finished = false

    constructor(private readonly options: StreamingTurnLifecycleOptions) {}

    observeResult(terminalId: string | null): void {
        if (this.finished) return
        if (
            this.options.requiresReview &&
            terminalId !== null &&
            this.waitingTerminalId === terminalId
        ) return
        this.turnsObserved++
        if (!this.options.requiresReview) {
            if (this.turnsObserved >= this.options.maxTurns) this.finish()
            else this.resetQuietTimer()
            return
        }
        if (!terminalId) {
            this.fail({
                error: "quality review requires a stable terminal turn identity",
                failure: {
                    kind: "infrastructure",
                    code: "review_uncorrelated",
                },
            })
            return
        }
        if (this.waitingTerminalId) {
            this.fail({
                error:
                    `received terminal ${terminalId} while awaiting review for ` +
                    this.waitingTerminalId,
                failure: {
                    kind: "infrastructure",
                    code: "review_uncorrelated",
                },
            })
            return
        }
        this.waitingTerminalId = terminalId
        void this.reviews
            .waitFor(terminalId, { timeoutMs: this.options.reviewTimeoutMs })
            .then((result) => this.applyWaitResult(terminalId, result))
    }

    observeMessage(): void {
        if (this.quietTimer !== null) this.resetQuietTimer()
    }

    deliverReview(review: CritiqueData): void {
        if (!this.finished) this.reviews.deliver(review)
    }

    cancel(): void {
        this.stop(false)
    }

    failure(): TurnReviewFailure | null {
        return this.reviewFailure
    }

    private applyWaitResult(
        terminalId: string,
        result: TurnReviewWaitResult,
    ): void {
        if (this.finished || this.waitingTerminalId !== terminalId) return
        this.waitingTerminalId = null
        if (result.kind === "cancelled") return
        if (result.kind === "timeout") {
            // In collective mode the worker's review wait only keeps a
            // streaming process open for same-session correction.  Once an
            // AcceptanceGate is bound, a missing/late Critique is Gate work:
            // close this execution successfully so its unchanged terminal
            // candidate reaches the Gate's independently bounded recheck.
            if (this.options.handoffInconclusiveToAcceptanceGate === true) {
                this.finish()
                return
            }
            this.fail(
                turnReviewTimeoutFailure(
                    terminalId,
                    this.options.reviewTimeoutMs,
                ),
            )
            return
        }

        const disposition = turnReviewDisposition(terminalId, result.review, {
            handoffInconclusiveToAcceptanceGate:
                this.options.handoffInconclusiveToAcceptanceGate === true,
        })
        if (disposition.kind === "failure") {
            this.fail(disposition)
        } else if (
            disposition.kind === "pass" ||
            disposition.kind === "handoff"
        ) {
            this.finish()
        } else if (this.turnsObserved >= this.options.maxTurns) {
            this.fail({
                error:
                    `quality review rejected terminal ${terminalId} ` +
                    `after maxTurns (${this.options.maxTurns})`,
                failure: { kind: "execution", code: "quality_rejected" },
            })
        } else {
            try {
                this.options.onRevision(disposition.feedback, result.review)
            } catch (error) {
                this.fail(this.options.revisionFailure(error))
            }
        }
    }

    private resetQuietTimer(): void {
        if (this.quietTimer) clearTimeout(this.quietTimer)
        this.quietTimer = setTimeout(
            () => this.finish(),
            this.options.quietTimeoutMs,
        )
    }

    private fail(failure: TurnReviewFailure): void {
        this.reviewFailure = failure
        this.finish()
    }

    private finish(): void {
        this.stop(true)
    }

    private stop(close: boolean): void {
        if (this.finished) return
        this.finished = true
        if (this.quietTimer) clearTimeout(this.quietTimer)
        this.quietTimer = null
        this.waitingTerminalId = null
        this.reviews.cancelActive()
        if (close) this.options.onFinish()
    }
}

/** Immutable copy: semantic-event payloads can outlive their delivery turn. */
export function snapshotTurnReview(review: CritiqueData): CritiqueData {
    return {
        ...review,
        violatedCriteria: [...review.violatedCriteria],
    }
}

/** Backend-neutral continuation prompt derived from an authoritative review. */
export function turnReviewFeedback(review: CritiqueData): string {
    const criteria = review.violatedCriteria.length > 0
        ? review.violatedCriteria.map((item) => `- ${item}`).join("\n")
        : "- Re-check every acceptance criterion and provide fresh test evidence."
    return [
        "The authoritative review rejected this candidate. Continue in the same worktree and context; do not restart the task.",
        "",
        review.reasoning || "The candidate did not yet satisfy acceptance.",
        "",
        "Violated criteria:",
        criteria,
        "",
        "Inspect the current changes, fix the underlying issue, re-run the relevant checks, and return a new terminal candidate.",
    ].join("\n")
}

export function turnReviewDisposition(
    terminalId: string,
    review: CritiqueData,
    options: { handoffInconclusiveToAcceptanceGate?: boolean } = {},
): TurnReviewDisposition {
    if (review.status === "inconclusive") {
        if (options.handoffInconclusiveToAcceptanceGate === true) {
            return { kind: "handoff" }
        }
        return {
            kind: "failure",
            ...inconclusiveTurnReviewFailure(terminalId, review),
        }
    }
    return review.verdict === "pass"
        ? { kind: "pass" }
        : { kind: "revise", feedback: turnReviewFeedback(review) }
}

export function turnReviewTimeoutFailure(
    terminalId: string,
    timeoutMs: number,
): TurnReviewFailure {
    return {
        error:
            `authoritative quality review timed out for terminal ` +
            `${terminalId} after ${timeoutMs}ms`,
        failure: { kind: "infrastructure", code: "review_timeout" },
    }
}

export function inconclusiveTurnReviewFailure(
    terminalId: string,
    review: CritiqueData,
): TurnReviewFailure {
    return {
        error:
            `quality evaluator could not decide terminal ${terminalId}: ` +
            (review.reasoning || "inconclusive review"),
        failure: { kind: "verification", code: "evaluator_unavailable" },
    }
}
