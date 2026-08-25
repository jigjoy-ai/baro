import {
    classifyProviderFailure,
    classifyTransportFailure,
} from "./provider-failure.js"

export interface TransientRetryOptions {
    /** Cap on the classified retry-after wait. */
    maxWaitMs?: number
    /**
     * Total provider attempts, including the first (default 2 = one retry).
     * Raise it only where the caller's own budget covers the extra calls.
     */
    maxAttempts?: number
    /** Base wait when the classified failure carries no retry-after (default 5000). */
    fallbackWaitMs?: number
    /** Extra veto: return false to fail closed even for a transient class. */
    retryable?: (error: unknown) => boolean
    /** Injection point so tests can assert the wait ladder without spending it. */
    sleep?: (ms: number) => Promise<void>
    /** Surface the retry decision (stderr log line, telemetry). */
    notice?: (message: string) => void
    /** Error renderer for the notice; defaults to Error.message. */
    describe?: (error: unknown) => string
}

/**
 * Classified retries for transient failures only. Deterministic failures (bad
 * contract, launch errors, empty results) still fail closed on the first
 * attempt — retrying those would burn a full provider budget on a guaranteed
 * repeat. `run` receives the attempt number (1, 2, …) so callers can keep
 * billing identities unique per dispatch.
 *
 * Waits grow per attempt: a network blip that killed one request usually
 * outlives a 3-second pause, and billing correlation disables the provider
 * SDK's own retries, so this is the only layer standing between a momentary
 * connection reset and a dead run.
 */
export async function withTransientRetry<T>(
    run: (attempt: number) => Promise<T>,
    options: TransientRetryOptions = {},
): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2)
    const sleep =
        options.sleep ??
        ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const describe =
        options.describe ??
        ((value: unknown) => (value instanceof Error ? value.message : String(value)))
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await run(attempt)
        } catch (error) {
            const failure =
                classifyProviderFailure(error) ?? classifyTransportFailure(error)
            const transient =
                failure?.kind === "provider_capacity" || failure?.kind === "transport"
            if (
                attempt >= maxAttempts ||
                !transient ||
                options.retryable?.(error) === false
            ) {
                throw error
            }
            // Exponential, not linear: the failures this catches are network
            // drops (VPN reroute, link flap) that outlive a few seconds, and
            // retrying inside the same outage just spends the budget without
            // moving. A provider-supplied retry-after still wins as the base.
            const base = failure?.retryAfterMs ?? options.fallbackWaitMs ?? 5_000
            const waitMs = Math.min(
                base * 3 ** (attempt - 1),
                options.maxWaitMs ?? 30_000,
            )
            options.notice?.(
                `attempt ${attempt} failed (${failure!.kind}): ${describe(error)}; ` +
                    `retrying in ${waitMs}ms`,
            )
            await sleep(waitMs)
        }
    }
}
