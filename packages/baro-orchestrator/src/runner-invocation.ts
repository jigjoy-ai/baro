import type {
    Metric,
    ModelCostMetrics,
    ModelInvocationGranularity,
    ModelInvocationStatus,
    ModelTokenMetrics,
} from "./model-telemetry.js"

/** Provider-neutral observation emitted by a concrete runner/model wrapper. */
export interface RunnerInvocationObservation {
    sequence: number
    granularity: ModelInvocationGranularity
    status: ModelInvocationStatus
    durationMs: Metric
    tokens: ModelTokenMetrics
    cost: ModelCostMetrics
    provider: string | null
    resolvedModel: string | null
    /** Real upstream request id only; harness session/thread ids do not qualify. */
    providerRequestId: string | null
}

export type RunnerInvocationObserver = (
    observation: RunnerInvocationObservation,
) => void

export type UnsequencedRunnerInvocationObservation = Omit<
    RunnerInvocationObservation,
    "sequence"
>

/**
 * Per-process observer guard shared by the one-shot CLI wrappers.
 *
 * A process can report both `error` and `exit`, and timeout termination can
 * race either event. `finish()` therefore settles exactly once and emits the
 * supplied fallback only when the stream produced no terminal invocation.
 * Observer failures are deliberately isolated from the model call: telemetry
 * is optional evidence and must not turn a successful runner into a failure.
 */
export class RunnerInvocationTracker {
    private sequence = 0
    private finished = false

    constructor(private readonly observer?: RunnerInvocationObserver) {}

    get observationCount(): number {
        return this.sequence
    }

    observe(observation: UnsequencedRunnerInvocationObservation): boolean {
        if (this.finished) return false
        this.deliver(observation)
        return true
    }

    finish(fallback: UnsequencedRunnerInvocationObservation): boolean {
        if (this.finished) return false
        // Mark first so a re-entrant/misbehaving callback cannot settle or
        // append another observation while the fallback is being delivered.
        this.finished = true
        if (this.sequence === 0) this.deliver(fallback)
        return true
    }

    private deliver(observation: UnsequencedRunnerInvocationObservation): void {
        this.sequence += 1
        try {
            this.observer?.({ sequence: this.sequence, ...observation })
        } catch {
            // A telemetry sink is observational; runner semantics win.
        }
    }
}
