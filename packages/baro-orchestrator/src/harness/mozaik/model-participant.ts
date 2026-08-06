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
    type Participant,
    type SemanticEvent,
    type Tool,
    type TokenUsage,
} from "../../runtime/mozaik.js"
import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    AgentUserMessage,
} from "../../semantic-events.js"
import { acceptsTargetedMessage } from "../../runtime/targeted-message-authority.js"
import type { GatewayBillingCoordinator } from "../../telemetry/billing/index.js"
import type { ModelInvocationPhase } from "../../telemetry/model-telemetry.js"
import {
    isProviderCallTimeout,
    runInferenceRound,
    UsageAccumulator,
} from "../openai/runtime.js"
import { withTransientRetry } from "../transient-retry.js"
import { invokeTool, runBoundedRound } from "./round.js"
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
    /**
     * Provider calls one turn may spend before it must answer. A turn is one
     * question and its answer; the session is the whole conversation, and the
     * two are not the same budget.
     */
    readonly maxRoundsPerTurn?: number
    /** Runaway guard for the whole session, far above any real phase. */
    readonly maxRounds?: number
    /** Per-round inference bound; silence beyond it ends the round. */
    readonly perRoundTimeoutSecs?: number
    /**
     * Optional deadline on waiting for more input. Off by default, and it
     * should stay off for a real phase — see `waitForInput`.
     */
    readonly quietTimeoutMs?: number
    /** The only bus voice allowed to hand this session a targeted message. */
    readonly targetedMessageAuthority?: Participant
    readonly targetedMessageCorrelation?: {
        runId: string
        leaseId: string
        generation: number
    }
    /**
     * Gateway billing for this session's own rounds. Omitted for an endpoint
     * we do not meter; without it a phase held by this lane spends real money
     * and reports nothing, because there is no CLI wrapper to read usage from.
     */
    readonly billing?: {
        readonly coordinator: GatewayBillingCoordinator
        readonly phase: ModelInvocationPhase
    }
}

/**
 * A turn's tool budget, and the session's runaway guard.
 *
 * These were one number, sixty, spent by the whole session — a bound written
 * for a lane where fifty tool steps happen inside one CLI process and are
 * never counted. Held to it, a live Architect spent every one of its sixty
 * calls reading the repository, hit the cap mid-research and took the run
 * down without ever asking its scouts a question.
 *
 * A turn that runs out is now told to answer with what it has: the last
 * rounds of its budget come with no working tools, which is what the story
 * lane already does. Only a session that has spent an implausible number of
 * calls across ALL its turns is stopped outright.
 */
const DEFAULT_MAX_ROUNDS_PER_TURN = 60
const DEFAULT_FINALIZATION_ROUNDS = 2
const DEFAULT_MAX_ROUNDS = 400
const TURN_BUDGET_SPENT =
    "Your tool budget for this turn is spent. Answer now with what you " +
    "already have, and state anything still unknown as an assumption. " +
    "Further tool calls will not run."
/**
 * The last resort for a call that will never answer, and deliberately far
 * above anything real work does.
 *
 * Baro removed its wall-clock caps in 0.82.0 for a good reason: silence is the
 * only honest clock, and a visibly working process must never be killed by a
 * stopwatch. A CLI lane earns that treatment by streaming tokens — every one
 * is proof of life, so the idle watchdog can tell working from hung.
 *
 * This lane cannot, yet. Mozaik 3.12 does expose `stream()`, but its
 * OpenAI-compatible adapter yields raw `chat.completion.chunk` events without
 * assembling them into items, and requests no `stream_options.include_usage`
 * — so a streamed round arrives with no token usage at all. Cache-accurate
 * usage is what every cost figure and the gateway's receipts are built on, so
 * trading it for a liveness signal would be the wrong trade.
 *
 * Until Mozaik streams with usage, a request in flight is genuinely
 * indistinguishable from a hang, and something has to end the latter: a live
 * run held one connection open for seventeen minutes with no error. This is
 * that something. It is set where it cannot plausibly fire on real work, and
 * it should be deleted — not tuned — the day a chunk can feed `onActivity`.
 */
const ROUND_BACKSTOP_SECS = 20 * 60
/**
 * No deadline on waiting, by default.
 *
 * A phase ends when the caller says it does. The CLI lane works exactly that
 * way — it holds stdin open and finishes when stdin closes — and all three
 * sessions are written to it: they hand the model more to read whenever they
 * have it, and close input when the conversation is over.
 *
 * This lane briefly ended a session after two seconds of quiet instead, which
 * meant the Architect declared itself finished and exited while its scouts
 * were still reading the repository. Waiting is not idleness when the next
 * message depends on other agents finishing work; a session that genuinely
 * hangs is caught by its round deadline and by the run's own watchdog, both
 * of which measure something real.
 */
const NO_QUIET_DEADLINE = 0

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
            | "maxRounds"
            | "maxRoundsPerTurn"
            | "perRoundTimeoutSecs"
            | "quietTimeoutMs"
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
    private turns = 0
    /** Round index within the current turn; billing correlates on both. */
    private roundInTurn = 0
    /** Resolves an idle wait early when something arrives. */
    private wake: (() => void) | null = null

    constructor(options: MozaikModelParticipantOptions) {
        super()
        this.agentId = options.agentId
        this.opts = {
            maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
            maxRoundsPerTurn:
                options.maxRoundsPerTurn ?? DEFAULT_MAX_ROUNDS_PER_TURN,
            perRoundTimeoutSecs:
                options.perRoundTimeoutSecs ?? ROUND_BACKSTOP_SECS,
            quietTimeoutMs: options.quietTimeoutMs ?? NO_QUIET_DEADLINE,
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

    /**
     * A peer's note, read between rounds.
     *
     * Horizontal awareness is delivered as an addressed bus event, and the CLI
     * lane forwards it to stdin. Without the same forwarding here a native
     * scout hears nothing its peers found, and the loss is silent — the round
     * still answers, only alone.
     */
    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!AgentTargetedMessage.is(event)) return
        if (
            !acceptsTargetedMessage(
                source,
                event.data,
                this.agentId,
                this.opts.targetedMessageAuthority,
                this.opts.targetedMessageCorrelation ?? {},
            )
        ) return
        this.sendUserMessage(event.data.text)
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
            return `session hit its runaway guard (${this.opts.maxRounds} rounds)`
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
        signal: AbortSignal,
    ): Promise<{ items: ContextItem[]; usage?: TokenUsage }> {
        const billing = this.opts.billing
        return await runInferenceRound(context, this.opts.model, {
            signal,
            ...(billing
                ? {
                      billing: {
                          coordinator: billing.coordinator,
                          context: {
                              // The coordinator stamps its own run id.
                              runId: null,
                              phase: billing.phase,
                              storyId: null,
                              leaseId: null,
                              generation: null,
                              attempt: null,
                              turn: this.turns + 1,
                              round: this.roundInTurn,
                          },
                      },
                  }
                : {}),
        })
    }

    /**
     * The end of a turn, said out loud.
     *
     * Every session over this port settles on `AgentResult` — the Architect's
     * reply stream, the planner's, the research board — because the CLI lane
     * publishes one per turn from Claude's `result` frame. Without it a native
     * phase completes its round, hands the reply to nobody, and waits with the
     * connection open until the idle watchdog ends it.
     *
     * Usage rides along for the same reason it does on the story lane: this is
     * the only place a native phase's tokens are ever reported.
     */
    private publishTurn(
        env: AgenticEnvironment,
        text: string,
        usage: UsageAccumulator,
    ): void {
        this.turns += 1
        env.deliverSemanticEvent(
            this,
            AgentResult.create({
                agentId: this.agentId,
                terminalId: `${this.agentId}:turn-${this.turns}`,
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: text,
                usage: usage.isEmpty ? null : usage.toJSON(),
                totalCostUsd: null,
                numTurns: null,
                durationMs: null,
            }),
        )
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
        // A turn spans every round until the model stops calling tools; both
        // reset when it is published.
        let turnText: string[] = []
        let turnUsage = new UsageAccumulator()
        const explorationBudget = Math.max(
            1,
            this.opts.maxRoundsPerTurn - DEFAULT_FINALIZATION_ROUNDS,
        )
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
                this.roundInTurn += 1
                this.emitState("running")
                // A dropped connection costs this round, not the phase. The
                // CLI lane retries inside its own client, so a blip there is
                // invisible; here it surfaced as the Architect losing ten
                // rounds of research and starting over from an empty context.
                const round = await withTransientRetry(
                    () =>
                        runBoundedRound({
                            round: (signal) => this.runRound(context, signal),
                            timeoutMs: this.opts.perRoundTimeoutSecs * 1000,
                            parentSignal: this.abortController.signal,
                            onActivity: () => this.onActivity?.(),
                        }),
                    {
                        maxAttempts: 3,
                        // Our own backstop already waited longer than any real
                        // call takes; waiting it out again is a second hang,
                        // not a retry.
                        retryable: (error) => !isProviderCallTimeout(error),
                        notice: (message) => {
                            this.onActivity?.()
                            process.stderr.write(
                                `[${this.agentId}] round ${this.rounds}: ${message}\n`,
                            )
                        },
                    },
                )
                this.onActivity?.()
                turnUsage.add(round.usage)

                const calls: FunctionCallItem[] = []
                for (const item of round.items) {
                    if (item.type === "function_call") {
                        await env.deliverFunctionCall(this, item as FunctionCallItem)
                        context = context.addContextItem(item)
                        calls.push(item as FunctionCallItem)
                    } else if (item.type === "message") {
                        await env.deliverModelMessage(this, item as ModelMessageItem)
                        context = context.addContextItem(item)
                        const text = textOf(item as ModelMessageItem)
                        this.messages.push(text)
                        turnText.push(text)
                        this.onActivity?.()
                    } else if (item.type === "reasoning") {
                        context = context.addContextItem(item)
                    }
                }

                // Past the exploration budget every call is answered, but
                // none runs: a function_call left without its output is an
                // invalid context, and refusing in the output is what makes
                // the model answer instead of reaching for another read.
                const budgetSpent = this.roundInTurn >= explorationBudget
                for (const call of calls) {
                    const output = budgetSpent
                        ? `Error: ${TURN_BUDGET_SPENT}`
                        : await invokeTool(
                              this.opts.tools ?? [],
                              { name: call.name, args: call.args },
                              this.abortController.signal,
                          )
                    const outItem = FunctionCallOutputItem.create(call.callId, output)
                    await env.deliverFunctionCallOutput(this, outItem)
                    context = context.addContextItem(outItem)
                    this.onActivity?.()
                }

                // A turn ends when the model stops calling tools; whether the
                // SESSION ends is the caller's call, made by handing it more to
                // read or by closing input. The loop head decides both.
                owesContinuation = calls.length > 0
                if (owesContinuation && budgetSpent) {
                    context = context.addContextItem(
                        UserMessageItem.create(TURN_BUDGET_SPENT),
                    )
                }
                // A turn that will not stop asking still ends as a turn: the
                // session stays open for whatever the caller says next.
                if (owesContinuation && this.roundInTurn >= this.opts.maxRoundsPerTurn) {
                    owesContinuation = false
                }
                if (!owesContinuation) {
                    // The turn's LAST message, as the CLI lane reports it:
                    // every consumer parses this text (questions, an outcome,
                    // a plan fragment), and mid-turn narration prepended to it
                    // is text their extractors have to survive.
                    this.publishTurn(
                        env,
                        turnText[turnText.length - 1] ?? "",
                        turnUsage,
                    )
                    turnText = []
                    turnUsage = new UsageAccumulator()
                    this.roundInTurn = 0
                }
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
                if (timer) clearTimeout(timer)
                this.wake = null
                resolve(value)
            }
            // Zero means wait for the caller, however long that takes.
            const timer =
                this.opts.quietTimeoutMs > 0
                    ? setTimeout(() => finish(false), this.opts.quietTimeoutMs)
                    : undefined
            this.wake = () => finish(this.inbox.length > 0)
        })
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
