import {
    classifyProviderFailure,
    classifyTransportFailure,
} from "./provider-failure.js"

export interface TransientRetryOptions {
    /** Cap on the classified retry-after wait. */
    maxWaitMs?: number
    /** Extra veto: return false to fail closed even for a transient class. */
    retryable?: (error: unknown) => boolean
    /** Surface the retry decision (stderr log line, telemetry). */
    notice?: (message: string) => void
    /** Error renderer for the notice; defaults to Error.message. */
    describe?: (error: unknown) => string
}

/**
 * One classified retry for transient failures only. Deterministic failures
 * (bad contract, launch errors, empty results) still fail closed on the first
 * attempt — retrying those would burn a full provider budget on a guaranteed
 * repeat. `run` receives the attempt number (1, then 2) so callers can keep
 * billing identities unique per dispatch.
 */
export async function withTransientRetry<T>(
    run: (attempt: number) => Promise<T>,
    options: TransientRetryOptions = {},
): Promise<T> {
    try {
        return await run(1)
    } catch (error) {
        const failure =
            classifyProviderFailure(error) ?? classifyTransportFailure(error)
        const transient =
            failure?.kind === "provider_capacity" || failure?.kind === "transport"
        if (!transient || options.retryable?.(error) === false) throw error
        const waitMs = Math.min(
            failure?.retryAfterMs ?? 3_000,
            options.maxWaitMs ?? 30_000,
        )
        const describe =
            options.describe ??
            ((value: unknown) =>
                value instanceof Error ? value.message : String(value))
        options.notice?.(
            `attempt 1 failed (${failure!.kind}): ${describe(error)}; ` +
                `retrying in ${waitMs}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        return await run(2)
    }
}
