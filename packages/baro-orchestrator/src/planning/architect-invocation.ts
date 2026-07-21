import type {
    RunnerInvocationObservation,
    RunnerInvocationObserver,
} from "../runner-invocation.js"

export interface ArchitectInvocationMetadata {
    /** True when the trusted inference interceptor already published this runner record. */
    readonly measurementPublished: boolean
    /** Intake is a distinct billing phase even when embedded in Architect routing. */
    readonly phase?: "intake"
    /** Exact routed model when it differs from the enclosing Architect model. */
    readonly requestedModel?: string
}

/** Provider-neutral, observational evidence for one Architect model call/round. */
export type ArchitectInvocationObserver = (
    observation: RunnerInvocationObservation,
    metadata: ArchitectInvocationMetadata,
) => void

export interface BufferedArchitectRunnerObserver {
    readonly onInvocation: RunnerInvocationObserver | undefined
    /** Publish buffered observations after the harness demonstrably started. */
    flush(): void
    /** Drop synthetic runner fallbacks when no provider process dispatched. */
    discard(): void
}

/**
 * One-shot runners synthesize a terminal observation even when spawn itself
 * fails. Buffer until the caller can distinguish ENOENT/EACCES/ENOTDIR from
 * an attributable provider attempt, so missing local tooling is never billed
 * or displayed as a model invocation.
 */
export function bufferedArchitectRunnerObserver(
    observer: ArchitectInvocationObserver | undefined,
): BufferedArchitectRunnerObserver {
    const pending: RunnerInvocationObservation[] = []
    let settled = false
    return {
        onInvocation: observer
            ? (observation) => {
                  if (!settled) pending.push(observation)
              }
            : undefined,
        flush: () => {
            if (settled) return
            settled = true
            for (const observation of pending) {
                observeArchitectInvocation(observer, observation, false)
            }
            pending.length = 0
        },
        discard: () => {
            settled = true
            pending.length = 0
        },
    }
}

export function isArchitectProcessLaunchFailure(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false
    const code = (error as { code?: unknown }).code
    return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR"
}

/** Deliver native/normalized telemetry without affecting Architect semantics. */
export function observeArchitectInvocation(
    observer: ArchitectInvocationObserver | undefined,
    observation: RunnerInvocationObservation,
    measurementPublished: boolean,
    attribution: Pick<
        ArchitectInvocationMetadata,
        "phase" | "requestedModel"
    > = {},
): void {
    try {
        observer?.(observation, { measurementPublished, ...attribution })
    } catch {
        // Telemetry is optional evidence; Architect semantics always win.
    }
}

/** Model routing is observational for continuation and must obey the same rule. */
export function observeArchitectModelResolved(
    observer: ((modelName: string) => void) | undefined,
    modelName: string,
): void {
    try {
        observer?.(modelName)
    } catch {
        // A continuation observer cannot change the selected model or phase.
    }
}
