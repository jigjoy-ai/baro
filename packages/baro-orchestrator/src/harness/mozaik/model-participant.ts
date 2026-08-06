/**
 * An interactive participant that lives inside our own loop.
 *
 * The CLI lane exists because a separate process cannot be handed a function:
 * its planner tool travels through a spawned MCP server, JSON-RPC over stdio, a
 * loopback socket and a shared secret to reach a handler in the process that
 * launched it. Here that whole apparatus collapses to passing `tools` — the
 * same mozaik `Tool` objects the story agents already use.
 *
 * The other thing owning the loop buys is the seam the CLI fakes with stdin: a
 * peer's finding is read between inference rounds, at a point where nothing is
 * half-written, rather than pushed at a process and hoped for.
 */

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelContext,
    ModelMessageItem,
    SystemMessageItem,
    UserMessageItem,
    type AgenticEnvironment,
    type ContextItem,
    type GenerativeModel,
    type Tool,
} from "../../runtime/mozaik.js"
import { AgentState, AgentUserMessage } from "../../semantic-events.js"
import {
    providerCallTimeoutError,
    runInferenceRound,
} from "../openai/runtime.js"
import type { InteractiveModelParticipant } from "../interactive-participant.js"

/**
 * What a finished session hands back.
 *
 * `done` SETTLES BY RESOLVING, always — a failed session reports itself here
 * rather than throwing. The CLI lane behaves the same way, and the sessions
 * are written to it: they attach `.then` to react to a session ending, with no
 * `.catch`, because a session ending is not an exception. A participant that
 * rejected instead took the whole phase down as an unhandled rejection.
 */
export interface MozaikSessionSummary {
    /** Every assistant message, in order. */
    readonly messages: readonly string[]
    /** The last assistant message, which is what callers usually parse. */
    readonly lastMessage: string
    readonly rounds: number
    /** Why the session stopped early, if it did. */
    readonly error: Error | null
}

export interface MozaikModelParticipantOptions {
    readonly agentId: string
    readonly model: GenerativeModel
    readonly systemPrompt: string
    readonly tools?: readonly Tool[]
    /** Rounds before the session is cut off. A conversation, not a budget. */
    readonly maxRounds?: number
    /** Per-round inference bound; silence beyond it ends the round. */
    readonly perRoundTimeoutSecs?: number
    /** Ms of quiet after a round before the session is considered finished. */
    readonly quietTimeoutMs?: number
}

const DEFAULT_MAX_ROUNDS = 60
const DEFAULT_ROUND_TIMEOUT_SECS = 300
const DEFAULT_QUIET_MS = 2_000
/** How often an in-flight provider call reports that it is still a call. */
const HEARTBEAT_MS = 5_000

export class MozaikModelParticipant
    extends BaseObserver
    implements InteractiveModelParticipant<MozaikSessionSummary>
{
    readonly agentId: string
    readonly done: Promise<MozaikSessionSummary>
    onActivity: (() => void) | null = null

    private readonly opts: Required<
        Pick<
            MozaikModelParticipantOptions,
            "maxRounds" | "perRoundTimeoutSecs" | "quietTimeoutMs"
        >
    > &
        MozaikModelParticipantOptions
    private readonly abortController = new AbortController()
    /** Text handed in while the session runs, read between rounds. */
    private readonly inbox: string[] = []
    private readonly messages: string[] = []
    private resolveDone!: (summary: MozaikSessionSummary) => void
    private failure: Error | null = null
    private envRef: AgenticEnvironment | null = null
    private started = false
    private inputClosed = false
    private settled = false
    private rounds = 0
    /** Resolves an idle wait early when something arrives. */
    private wake: (() => void) | null = null

    constructor(options: MozaikModelParticipantOptions) {
        super()
        this.agentId = options.agentId
        this.opts = {
            maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
            perRoundTimeoutSecs:
                options.perRoundTimeoutSecs ?? DEFAULT_ROUND_TIMEOUT_SECS,
            quietTimeoutMs: options.quietTimeoutMs ?? DEFAULT_QUIET_MS,
            ...options,
        }
        setModelTools(options.model, [...(options.tools ?? [])])
        this.done = new Promise<MozaikSessionSummary>((resolve) => {
            this.resolveDone = resolve
        })
    }

    start(environment: AgenticEnvironment): void {
        if (this.started) return
        this.started = true
        this.envRef = environment
        void this.run()
    }

    sendUserMessage(text: string): void {
        if (this.settled) return
        this.inbox.push(text)
        this.wake?.()
        this.onActivity?.()
    }

    /** No more input is coming. The session ends after the model settles. */
    closeStdin(): void {
        this.inputClosed = true
        this.wake?.()
    }

    async abortAndWait(_signal?: NodeJS.Signals): Promise<boolean> {
        this.abortController.abort()
        this.wake?.()
        await this.done
        return true
    }

    sessionEndDetail(): string {
        if (this.failure) return this.failure.message
        if (this.abortController.signal.aborted) return "session was aborted"
        if (this.rounds >= this.opts.maxRounds) {
            return `session hit its round cap (${this.opts.maxRounds})`
        }
        return `session ended after ${this.rounds} round(s) with ${this.messages.length} reply(ies)`
    }

    private settle(phase: "done" | "failed", failure: Error | null): void {
        if (this.settled) return
        this.settled = true
        this.failure = failure
        this.emitState(phase)
        this.resolveDone({
            messages: [...this.messages],
            lastMessage: this.messages[this.messages.length - 1] ?? "",
            rounds: this.rounds,
            error: failure,
        })
    }

    /** One provider call. Separated so a test can drive the loop offline. */
    protected async runRound(
        context: ModelContext,
    ): Promise<{ items: ContextItem[] }> {
        return await runInferenceRound(context, this.opts.model, {
            signal: this.abortController.signal,
        })
    }

    /**
     * The bound the heartbeat below depends on being real.
     *
     * `runInferenceRound` cancels on a signal but imposes no deadline of its
     * own, so nothing ended a call that never answered. A run on this lane sat
     * seventeen minutes on one request with the connection open and the
     * watchdog kept quiet by the heartbeat — a hang made invisible by the very
     * thing that was supposed to be safe because "the round is bounded".
     * It is bounded here, and a timeout is reported as a timeout rather than
     * as cancellation, which telemetry and billing distinguish.
     */
    private async runBoundedRound(
        context: ModelContext,
    ): Promise<{ items: ContextItem[] }> {
        const timeoutMs = this.opts.perRoundTimeoutSecs * 1000
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                this.abortController.abort()
                reject(providerCallTimeoutError(timeoutMs))
            }, timeoutMs)
        })
        try {
            return await Promise.race([this.runRound(context), deadline])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    /**
     * A provider call in flight is not silence.
     *
     * A CLI participant streams tokens, so the watchdog that ends a stalled
     * session sees a heartbeat for free. This lane gets one response at the
     * end of a round, so a long call looked exactly like a hang and the
     * watchdog aborted a phase that was working — which is how the first live
     * run on this lane died.
     *
     * This cannot hide a real hang only because `runBoundedRound` gives the
     * round a deadline of its own — the first version of this comment claimed
     * that bound existed when it did not, and a hung call ran unbounded
     * behind a heartbeat that kept the watchdog quiet.
     */
    private async withHeartbeat<T>(work: Promise<T>): Promise<T> {
        const beat = setInterval(() => this.onActivity?.(), HEARTBEAT_MS)
        try {
            return await work
        } finally {
            clearInterval(beat)
        }
    }

    private emitState(phase: "starting" | "running" | "done" | "failed"): void {
        this.envRef?.deliverSemanticEvent(
            this,
            AgentState.create({ agentId: this.agentId, phase, detail: "" }),
        )
    }

    private async run(): Promise<void> {
        const env = this.envRef
        if (!env) return
        this.emitState("starting")
        let context = ModelContext.create(this.agentId).addContextItem(
            SystemMessageItem.create(this.opts.systemPrompt),
        )

        // True when the last round ended in tool calls: the model has been
        // handed their results and owes an answer.
        let owesContinuation = false
        try {
            while (this.rounds < this.opts.maxRounds) {
                if (this.abortController.signal.aborted) {
                    throw new Error(`[${this.agentId}] session aborted`)
                }

                // Read everything waiting before deciding anything. This is the
                // seam stdin approximates: a peer's finding lands here, between
                // rounds, where nothing is half-written.
                const pending = this.inbox.splice(0, this.inbox.length)
                for (const text of pending) {
                    context = context.addContextItem(UserMessageItem.create(text))
                    env.deliverSemanticEvent(
                        this,
                        AgentUserMessage.create({ agentId: this.agentId, text }),
                    )
                }

                // A round costs a provider call, so one is spent only when
                // there is something to answer — text just handed in, or a
                // tool result the model owes a reply to. Starting the session
                // is not itself something to answer: `start` runs before the
                // caller's first message, and a round fired there would ask
                // the model to act on a system prompt alone.
                if (pending.length === 0 && !owesContinuation) {
                    if (!(await this.waitForInput())) break
                    continue
                }

                this.rounds += 1
                this.emitState("running")
                const round = await this.withHeartbeat(this.runBoundedRound(context))
                this.onActivity?.()

                const calls: FunctionCallItem[] = []
                for (const item of round.items) {
                    if (item.type === "function_call") {
                        await env.deliverFunctionCall(this, item as FunctionCallItem)
                        context = context.addContextItem(item)
                        calls.push(item as FunctionCallItem)
                    } else if (item.type === "message") {
                        await env.deliverModelMessage(this, item as ModelMessageItem)
                        context = context.addContextItem(item)
                        this.messages.push(textOf(item as ModelMessageItem))
                        this.onActivity?.()
                    } else if (item.type === "reasoning") {
                        context = context.addContextItem(item)
                    }
                }

                for (const call of calls) {
                    const output = await this.invokeTool(call)
                    const outItem = FunctionCallOutputItem.create(call.callId, output)
                    await env.deliverFunctionCallOutput(this, outItem)
                    context = context.addContextItem(outItem)
                    this.onActivity?.()
                }

                // A turn ends when the model stops calling tools; whether the
                // SESSION ends is the caller's call, made by handing it more to
                // read or by closing input. The loop head decides both.
                owesContinuation = calls.length > 0
            }

            this.settle("done", null)
        } catch (error) {
            this.settle(
                "failed",
                error instanceof Error ? error : new Error(String(error)),
            )
        }
    }

    /** True if something arrived; false if the quiet window expired. */
    private waitForInput(): Promise<boolean> {
        if (this.inbox.length > 0) return Promise.resolve(true)
        if (this.inputClosed || this.abortController.signal.aborted) {
            return Promise.resolve(false)
        }
        return new Promise<boolean>((resolve) => {
            let settled = false
            const finish = (value: boolean): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                this.wake = null
                resolve(value)
            }
            const timer = setTimeout(() => finish(false), this.opts.quietTimeoutMs)
            this.wake = () => finish(this.inbox.length > 0)
        })
    }

    private async invokeTool(call: FunctionCallItem): Promise<string> {
        const tool = (this.opts.tools ?? []).find(
            (candidate) => candidate.name === call.name,
        )
        if (!tool) return `Error: tool '${call.name}' is not available here`
        let args: unknown
        try {
            args = JSON.parse(call.args)
        } catch (error) {
            return `Error: tool args were not valid JSON: ${messageOf(error)}`
        }
        try {
            const result = await tool.invoke(args)
            return typeof result === "string" ? result : JSON.stringify(result)
        } catch (error) {
            return `Error running ${tool.name}: ${messageOf(error)}`
        }
    }
}

function textOf(item: ModelMessageItem): string {
    const json = item.toJSON() as { content?: Array<{ text?: string }> }
    return json.content?.[0]?.text ?? ""
}

function messageOf(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}

function setModelTools(model: GenerativeModel, tools: Tool[]): void {
    if (tools.length === 0) return
    const withTools = model as unknown as { setTools?: (t: Tool[]) => void }
    if (typeof withTools.setTools !== "function") {
        throw new Error(
            `MozaikModelParticipant: model ${model.specification.name} does not implement ToolCallingCapability`,
        )
    }
    withTools.setTools(tools)
}
