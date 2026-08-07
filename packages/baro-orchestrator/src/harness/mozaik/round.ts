/**
 * One provider call, and one tool call — the two mechanics every lane that
 * runs inference in this process needs, kept in one place.
 *
 * They were written twice: once in the story agent and once in the interactive
 * participant. Each copy then acquired its own fixes at its own time, and they
 * drifted — one aborted a request on timeout while the other only stopped
 * waiting for it, one reported liveness while the other went silent. The bugs
 * that cost a live run were all in this territory, so it stops being territory
 * and becomes two functions.
 */

import type { Tool } from "../../runtime/mozaik.js"
import { providerCallTimeoutError } from "../openai/runtime.js"

/** How often an in-flight call reports that it is still a call. */
const HEARTBEAT_MS = 5_000

export interface BoundedRoundOptions<T> {
    /**
     * The provider call. It is handed a signal scoped to THIS round, which the
     * deadline cancels — the caller's own abort is a different scope and must
     * not be tripped by a round running out of time. Conflating them turns an
     * attempt that timed out into a story that was cancelled, and the two are
     * neither retried nor billed the same way.
     *
     * The second argument is how the call reports that the provider delivered
     * something. Every report pushes the deadline out, because what the
     * deadline is for is silence.
     */
    readonly round: (signal: AbortSignal, progress: () => void) => Promise<T>
    /**
     * How long the call may stay SILENT. Not how long it may take.
     *
     * Baro removed wall-clock caps on work in 0.82.0 and left this one because
     * a request in flight was indistinguishable from a dead socket: with
     * nothing arriving, elapsed time was the only measurable thing. That is no
     * longer true where the lane streams — every chunk is proof — so this
     * became what it always meant to be.
     *
     * It mattered: a story lane carried three minutes here, a number from when
     * rounds were short. DeepSeek Flash writes fifteen thousand tokens in a
     * round and takes about that long, so the deadline stopped measuring
     * failure and started cutting healthy work, three stories in one run.
     *
     * A call that reports nothing — a lane that cannot stream — still gets the
     * old meaning, which is the only honest reading when nothing is arriving.
     */
    readonly timeoutMs: number
    /** The caller's abort. When it fires, this round is cancelled with it. */
    readonly parentSignal?: AbortSignal
    /** Names what timed out, so a diagnostic says which round rather than
     * only that some provider call did. */
    readonly label?: string
    /**
     * Called while the call is in flight. A lane that streams gets liveness
     * per token for free; one that does not would look identical to a hang,
     * and a watchdog would end a phase that was working.
     */
    readonly onActivity?: () => void
}

/**
 * Run one provider call under a deadline, reporting liveness while it runs.
 *
 * A timeout raises `providerCallTimeoutError`, which telemetry and billing
 * read differently from a cancellation — a deadline attributed to shutdown
 * lands in the wrong column.
 */
export async function runBoundedRound<T>(
    options: BoundedRoundOptions<T>,
): Promise<T> {
    let progressed: (() => void) | undefined
    const controller = new AbortController()
    const parent = options.parentSignal
    const onParentAbort = (): void => controller.abort(parent?.reason)
    if (parent?.aborted) controller.abort(parent.reason)
    else parent?.addEventListener("abort", onParentAbort, { once: true })

    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    // The heartbeat keeps the caller's watchdogs fed while a call is in
    // flight, and deliberately does NOT touch the deadline: it fires whether
    // or not anything is arriving, so a deadline it could postpone would never
    // fire at all.
    const beat = options.onActivity
        ? setInterval(options.onActivity, HEARTBEAT_MS)
        : undefined
    const deadline = new Promise<never>((_, reject) => {
        const arm = (): void => {
            timer = setTimeout(() => {
                if (settled) return
                controller.abort()
                reject(providerCallTimeoutError(options.timeoutMs, options.label))
            }, options.timeoutMs)
        }
        arm()
        progressed = (): void => {
            if (settled) return
            if (timer) clearTimeout(timer)
            arm()
            options.onActivity?.()
        }
    })
    try {
        return await Promise.race([
            options.round(controller.signal, () => progressed?.()),
            deadline,
        ])
    } finally {
        settled = true
        if (timer) clearTimeout(timer)
        if (beat) clearInterval(beat)
        parent?.removeEventListener("abort", onParentAbort)
    }
}

/**
 * Invoke a tool the model asked for, and never throw at the caller.
 *
 * Every failure here is something the model can act on — an unknown name,
 * malformed arguments, a tool that blew up — so each comes back as text it
 * reads in the next round rather than as an exception that ends the session.
 */
export async function invokeTool(
    tools: readonly Tool[],
    call: { name: string; args: string },
    signal?: AbortSignal,
): Promise<string> {
    const tool = tools.find((candidate) => candidate.name === call.name)
    if (!tool) return `Error: tool '${call.name}' is not available here`

    let parsed: unknown
    try {
        parsed = JSON.parse(call.args)
    } catch (error) {
        return `Error: tool args were not valid JSON: ${messageOf(error)}`
    }

    try {
        const signalAware = tool as Tool & {
            invokeWithSignal?: (
                args: unknown,
                signal: AbortSignal,
            ) => Promise<unknown>
        }
        const result =
            signal && signalAware.invokeWithSignal
                ? await signalAware.invokeWithSignal(parsed, signal)
                : await tool.invoke(parsed)
        return typeof result === "string" ? result : JSON.stringify(result)
    } catch (error) {
        return `Error running ${tool.name}: ${messageOf(error)}`
    }
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}
