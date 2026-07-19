import type { Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    AgentTurnCompleted,
    Critique,
    type CritiqueData,
    type StoryFailureData,
} from "../semantic-events.js"
import {
    TurnReviewMailbox,
    snapshotTurnReview,
    turnReviewDisposition,
    turnReviewTimeoutFailure,
} from "./turn-review.js"

export interface OneShotTurnReviewOptions {
    agentId: string
    requiresReview: boolean
    terminalAuthority?: Participant
    authority?: Participant
    timeoutMs: number
    /** Collective-only: the AcceptanceGate may recheck an unchanged terminal. */
    handoffInconclusiveToAcceptanceGate?: boolean
    /** Keep the local lane surgical; structural recovery owns larger changes. */
    maxSurgicalRevisions: number
}

export type OneShotTurnReviewResult =
    | { kind: "pass" }
    | { kind: "handoff" }
    | { kind: "revise"; feedback: string; review: CritiqueData; revision: number }
    | { kind: "cancelled" }
    | {
          kind: "failure"
          error: string
          failure: StoryFailureData
      }

/**
 * Authoritative review handshake for CLI backends whose processes are
 * one-shot. A rejected candidate is repaired by a fresh process in the same
 * live worktree, before StoryResult lets AcceptanceGate/Board tear it down.
 */
export class OneShotTurnReview {
    private readonly reviews = new TurnReviewMailbox()
    private readonly cancellation = new AbortController()
    private readonly seenTerminalIds = new Set<string>()
    private candidateTerminalIds: string[] = []
    private terminalWaiter: ((terminalId: string | null) => void) | null = null
    private collectingCandidate = false
    private revisions = 0

    constructor(private readonly options: OneShotTurnReviewOptions) {
        if (
            options.requiresReview &&
            (!options.authority || !options.terminalAuthority)
        ) {
            throw new Error(
                `${options.agentId} requires exact terminal and review authorities`,
            )
        }
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
            throw new RangeError(
                "one-shot turn review timeout must be non-negative",
            )
        }
        if (
            !Number.isInteger(options.maxSurgicalRevisions) ||
            options.maxSurgicalRevisions < 0
        ) {
            throw new RangeError(
                "maxSurgicalRevisions must be a non-negative integer",
            )
        }
    }

    get requiresReview(): boolean {
        return this.options.requiresReview
    }

    /** Start correlating projected terminals for one concrete CLI process. */
    beginCandidate(): void {
        if (!this.options.requiresReview) return
        if (this.collectingCandidate) {
            throw new Error(
                `candidate review already active for ${this.options.agentId}`,
            )
        }
        this.collectingCandidate = true
        this.candidateTerminalIds = []
    }

    /** A transport/model failure is not a candidate for quality review. */
    discardCandidate(): void {
        this.finishCandidate()
    }

    /** Returns true only for a review consumed by this exact story lane. */
    observe(source: Participant, event: SemanticEvent<unknown>): boolean {
        if (
            this.options.requiresReview &&
            source === this.options.terminalAuthority &&
            AgentTurnCompleted.is(event) &&
            event.data.agentId === this.options.agentId
        ) {
            const terminalId = normalizedTerminalId(event.data.terminalId)
            if (
                this.collectingCandidate &&
                terminalId &&
                !event.data.isError &&
                event.data.resultText &&
                !this.seenTerminalIds.has(terminalId)
            ) {
                this.seenTerminalIds.add(terminalId)
                this.candidateTerminalIds.push(terminalId)
                this.terminalWaiter?.(terminalId)
                this.terminalWaiter = null
            }
            return true
        }
        if (
            !this.options.requiresReview ||
            source !== this.options.authority ||
            !Critique.is(event) ||
            event.data.agentId !== this.options.agentId
        ) return false

        this.reviews.deliver(snapshotTurnReview(event.data))
        return true
    }

    async reviewNext(): Promise<OneShotTurnReviewResult> {
        if (!this.options.requiresReview) return { kind: "pass" }
        if (!this.collectingCandidate) {
            throw new Error(
                `no active candidate review for ${this.options.agentId}`,
            )
        }

        const deadline = Date.now() + this.options.timeoutMs
        let terminalId = this.candidateTerminalIds.at(-1) ?? null
        if (!terminalId) {
            terminalId = await this.waitForTerminal(deadline)
            // Event delivery is synchronous today; this microtask also lets a
            // provider's final adjacent terminal frame become the selected one.
            await Promise.resolve()
            terminalId = this.candidateTerminalIds.at(-1) ?? terminalId
        }
        if (!terminalId) {
            this.finishCandidate()
            if (this.cancellation.signal.aborted) return { kind: "cancelled" }
            return {
                kind: "failure",
                error:
                    `quality review requires a stable projected terminal ` +
                    `for ${this.options.agentId}`,
                failure: {
                    kind: "infrastructure",
                    code: "review_uncorrelated",
                },
            }
        }

        const wait = await this.reviews.waitFor(terminalId, {
            timeoutMs: Math.max(0, deadline - Date.now()),
            signal: this.cancellation.signal,
        })
        this.finishCandidate()
        if (wait.kind === "cancelled") return { kind: "cancelled" }
        if (wait.kind === "timeout") {
            if (this.options.handoffInconclusiveToAcceptanceGate === true) {
                return { kind: "handoff" }
            }
            return {
                kind: "failure",
                ...turnReviewTimeoutFailure(terminalId, this.options.timeoutMs),
            }
        }
        const review = wait.review

        const disposition = turnReviewDisposition(terminalId, review, {
            handoffInconclusiveToAcceptanceGate:
                this.options.handoffInconclusiveToAcceptanceGate === true,
        })
        if (disposition.kind !== "revise") return disposition
        if (this.revisions >= this.options.maxSurgicalRevisions) {
            if (this.options.handoffInconclusiveToAcceptanceGate === true) {
                return { kind: "handoff" }
            }
            return {
                kind: "failure",
                error:
                    `quality review rejected terminal ${terminalId} after ` +
                    `${this.revisions} surgical revision(s)`,
                failure: { kind: "execution", code: "quality_rejected" },
            }
        }

        this.revisions++
        return {
            kind: "revise",
            feedback: disposition.feedback,
            review,
            revision: this.revisions,
        }
    }

    cancel(): void {
        this.cancellation.abort()
        this.reviews.cancelActive()
        this.terminalWaiter?.(null)
        this.terminalWaiter = null
        this.finishCandidate()
    }

    private waitForTerminal(deadline: number): Promise<string | null> {
        if (this.candidateTerminalIds.length > 0) {
            return Promise.resolve(this.candidateTerminalIds.at(-1) ?? null)
        }
        return new Promise<string | null>((resolve) => {
            const remaining = Math.max(0, deadline - Date.now())
            let settled = false
            const finish = (terminalId: string | null) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                this.cancellation.signal.removeEventListener("abort", onAbort)
                if (this.terminalWaiter === finish) this.terminalWaiter = null
                resolve(terminalId)
            }
            const onAbort = () => finish(null)
            const timer = setTimeout(() => finish(null), remaining)
            this.terminalWaiter = finish
            if (this.candidateTerminalIds.length > 0) {
                finish(this.candidateTerminalIds.at(-1) ?? null)
            } else if (this.cancellation.signal.aborted) {
                finish(null)
            } else {
                this.cancellation.signal.addEventListener("abort", onAbort, {
                    once: true,
                })
            }
        })
    }

    private finishCandidate(): void {
        this.collectingCandidate = false
        this.candidateTerminalIds = []
    }
}

/** Prompt for a fresh process that inherits files, not conversation memory. */
export function oneShotSurgicalRevisionPrompt(
    originalContract: string,
    review: CritiqueData,
): string {
    const criteria = review.violatedCriteria.length > 0
        ? review.violatedCriteria.map((item) => `- ${item}`).join("\n")
        : "- Re-check every acceptance criterion and provide fresh test evidence."
    return [
        "Perform a narrow surgical repair of the existing candidate in this worktree.",
        "The previous process has exited; its files and commits remain, but you do not share its conversation context.",
        "Preserve correct work, avoid unrelated rewrites, and fix the smallest underlying cause that satisfies the contract.",
        "",
        "Original story contract:",
        originalContract,
        "",
        "Authoritative review of the current candidate:",
        review.reasoning || "The candidate did not yet satisfy acceptance.",
        "",
        "Violated criteria:",
        criteria,
        "",
        "Inspect the current diff, make the focused correction, re-run the relevant checks, and return a new terminal candidate.",
    ].join("\n")
}

function normalizedTerminalId(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null
}
