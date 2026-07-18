/**
 * OpenAIStoryAgent — multi-turn coding loop on the OpenAI Responses API via
 * Mozaik's native inference runner. Emits the same bus contract as StoryAgent
 * (Claude) so downstream observers (Critic, Surgeon, Sentry, Librarian,
 * Cartographer) can't tell which backend ran. One TURN = inference rounds
 * until the model replies with no tool calls; end-of-turn AgentResult fires
 * Critic, then we wait quietTimeoutMs for an AgentTargetedMessage before
 * either running another turn or finishing.
 */

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    ModelMessageItem,
    Participant,
    SemanticEvent,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Tool,
} from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import type { GatewayBillingCoordinator } from "../billing/index.js"
import {
    GenericOpenAIModel,
    type OpenAIConnection,
    UsageAccumulator,
    runInferenceRound,
} from "../planning/openai-runtime.js"
import { createStoryTools } from "../planning/story-tools.js"
import {
    AgentResult,
    AgentState,
    AgentTargetedMessage,
    AgentUserMessage,
    Critique,
    RuntimeReplanApplied,
    RuntimeReplanProposed,
    RuntimeReplanRejected,
    StoryResult,
    type AgentPhase,
    type RuntimeReplanAppliedData,
    type RuntimeReplanRejectedData,
    type StoryFailureData,
} from "../semantic-events.js"
import {
    classifyStoryFailure,
    compactProviderFailureDetail,
} from "../provider-failure.js"
import { acceptsTargetedMessage } from "../runtime/targeted-message-authority.js"
import { correlationOf, type StoryOutcome, type StorySpec } from "./story-agent.js"
import type { StoryCollaborationAccess } from "./story-executor.js"
import {
    createRuntimeReplanTool,
    parseRuntimeReplanArgs,
    runtimeReplanToolOutput,
    validGraphVersion,
    type PendingRuntimeReplan,
    type RuntimeReplanDecision,
} from "./runtime-replan-tool.js"
import {
    TurnMessageMailbox,
    TurnReviewMailbox,
    turnReviewDisposition,
    turnReviewTimeoutFailure,
} from "./turn-review.js"

const STORY_SYSTEM_PROMPT = `\
You are an autonomous coding agent. The user will hand you exactly one
focused story: a goal plus acceptance criteria and (optionally) test
commands. Your job is to read the relevant code, make the changes that
satisfy every acceptance criterion, run the tests, and commit.

Tools available (call them as function calls; arguments are JSON):
  read_file, list_files, file_tree, grep, glob   — explore the repo
  write_file                                       — create or overwrite
  edit_file                                        — find-and-replace
  bash                                             — run any shell cmd
                                                     (build, test, git…)

Rules:
- Stay tightly inside the story scope. Do NOT refactor unrelated code.
  If you notice an unrelated issue, note it in your final commit body
  under "Noted (out of scope)" — don't fix it inline.
- Before you write code, READ the files you'll touch. Confirm exact
  function names, exact paths.
- When you edit, use edit_file with enough surrounding context to make
  the match unique. write_file is for new files or full rewrites only.
- After your edits, run the test commands the story specified. Use the
  bash tool. Fix any failures and re-run.
- When you're done, run \`git add -A && git commit -m "..."\` via bash
  with a concise message. Then respond with a brief summary message
  (no more tool calls) — that signals the turn is over.

You may be sent corrective feedback after your turn. If you receive a
follow-up user message, treat it as additional acceptance criteria
and revise.`

export interface OpenAIStoryAgentOptions {
    model?: string
    /** Cap on inference rounds within one TURN (round = one runner.run() + tool exec). */
    maxRoundsPerTurn?: number
    /**
     * Rounds reserved at the end of a turn for a no-tool final summary.
     * At least one exploration round is retained when maxRoundsPerTurn > 0.
     */
    finalizationRoundsPerTurn?: number
    perRoundTimeoutSecs?: number
    /** Reconnect attempts for a provider request that rejected with a
     * transport error. Local watchdog timeouts are never overlapped. */
    transportRetriesPerRound?: number
    transportRetryDelayMs?: number
    /**
     * Per-story OpenAI-compatible endpoint. Overrides the process-global
     * `OPENAI_BASE_URL` for this story only and forces `GenericOpenAIModel`
     * (the built-in gpt-5.x classes are hard-wired to OpenAI). Lets one run
     * mix endpoints (e.g. MiniMax + real OpenAI).
     */
    baseUrl?: string
    /** API key paired with `baseUrl`. */
    apiKey?: string
    /** Only this participant may decide a runtime DAG proposal. The tool is
     * unavailable when this or the story's collective correlation is absent. */
    runtimeReplanDecisionAuthority?: Participant
    /** How long a propose_replan call waits for its exact Board decision. */
    runtimeReplanDecisionTimeoutMs?: number
    /** Exact Critic whose verdict completes or resumes a reviewed turn. */
    turnReviewAuthority?: Participant
    /** Bound for one terminal-turn review. Default: 240 seconds. */
    turnReviewTimeoutMs?: number
    /** Exact lease capability made available to the contained native shell.
     * Manager-private Bridge state and filesystem paths are never exposed. */
    collaboration?: StoryCollaborationAccess
    /** Trusted Gateway billing interceptor. Omitted for direct/unmetered endpoints. */
    billingCoordinator?: GatewayBillingCoordinator
}

interface ResolvedOpenAIStoryAgentOptions {
    model: string
    maxRoundsPerTurn: number
    finalizationRoundsPerTurn: number
    perRoundTimeoutSecs: number
    transportRetriesPerRound: number
    transportRetryDelayMs: number
    baseUrl: string
    apiKey: string
    runtimeReplanDecisionAuthority: Participant | null
    runtimeReplanDecisionTimeoutMs: number
    turnReviewAuthority: Participant | null
    turnReviewTimeoutMs: number
}

let openAIStoryProducerSequence = 0

export class OpenAIStoryAgent extends BaseObserver {
    private readonly spec: Required<
        Pick<
            StorySpec,
            | "retries"
            | "timeoutSecs"
            | "retryDelayMs"
            | "quietTimeoutMs"
            | "maxTurns"
            | "hardTimeoutSecs"
        >
    > &
        StorySpec
    private readonly opts: ResolvedOpenAIStoryAgentOptions
    private readonly model: GenerativeModel
    private readonly tools: Tool[]
    private readonly billingCoordinator: GatewayBillingCoordinator | null
    private runtimeGraphVersion: number | null
    private readonly pendingRuntimeReplans = new Map<
        string,
        PendingRuntimeReplan
    >()

    private envRef: AgenticEnvironment | null = null
    private readonly abortController = new AbortController()
    private abortReason: string | null = null
    private abortFailure: StoryFailureData | undefined
    /** Optional explicit bus identity for the terminal outcome. */
    private resultAuthority: Participant | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private readonly terminalProducerId = ++openAIStoryProducerSequence
    private terminalSequence = 0
    private resolveDone!: (outcome: StoryOutcome) => void
    public readonly done: Promise<StoryOutcome>

    private readonly turnMessages = new TurnMessageMailbox<string>()
    private readonly turnReviews = new TurnReviewMailbox()

    constructor(spec: StorySpec, opts: OpenAIStoryAgentOptions = {}) {
        super()
        this.spec = {
            retries: 2,
            timeoutSecs: 600,
            retryDelayMs: 1500,
            quietTimeoutMs: 2000,
            maxTurns: 4,
            hardTimeoutSecs: 0,
            ...spec,
        }
        const maxRoundsPerTurn = boundedRoundCount(
            opts.maxRoundsPerTurn ?? 30,
        )
        this.opts = {
            model: opts.model ?? "gpt-5.5",
            maxRoundsPerTurn,
            finalizationRoundsPerTurn: boundedFinalizationRounds(
                maxRoundsPerTurn,
                opts.finalizationRoundsPerTurn ?? 3,
            ),
            perRoundTimeoutSecs: opts.perRoundTimeoutSecs ?? 180,
            transportRetriesPerRound: Math.max(
                0,
                Math.floor(opts.transportRetriesPerRound ?? 2),
            ),
            transportRetryDelayMs: Math.max(
                0,
                Math.floor(opts.transportRetryDelayMs ?? 1_000),
            ),
            baseUrl: opts.baseUrl ?? "",
            apiKey: opts.apiKey ?? "",
            runtimeReplanDecisionAuthority:
                opts.runtimeReplanDecisionAuthority ?? null,
            runtimeReplanDecisionTimeoutMs:
                opts.runtimeReplanDecisionTimeoutMs ?? 30_000,
            turnReviewAuthority: opts.turnReviewAuthority ?? null,
            turnReviewTimeoutMs: opts.turnReviewTimeoutMs ?? 240_000,
        }
        this.billingCoordinator = opts.billingCoordinator ?? null
        if (spec.requiresQualityReview && !this.opts.turnReviewAuthority) {
            throw new Error(
                `OpenAIStoryAgent ${spec.id} requires a turnReviewAuthority`,
            )
        }
        this.runtimeGraphVersion = validGraphVersion(spec.graphVersion)
            ? spec.graphVersion
            : null
        const connection: OpenAIConnection | undefined = opts.baseUrl
            ? { baseURL: opts.baseUrl, apiKey: opts.apiKey }
            : undefined
        this.model = pickModel(this.opts.model, connection)
        this.tools = [
            ...createStoryTools(spec.cwd, {
                collaboration: opts.collaboration,
            }),
            ...(this.runtimeReplanEnabled()
                ? [createRuntimeReplanTool(this.runtimeGraphVersion!)]
                : []),
        ]
        setModelTools(this.model, this.tools)

        this.done = new Promise<StoryOutcome>((res) => {
            this.resolveDone = res
        })
    }

    get id(): string {
        return this.spec.id
    }
    get agentId(): string {
        return this.spec.id
    }

    getPhase(): AgentPhase {
        return this.currentPhase
    }

    setResultAuthority(source: Participant): void {
        if (this.resultAuthority && this.resultAuthority !== source) {
            throw new Error(`result authority already set for ${this.spec.id}`)
        }
        this.resultAuthority = source
    }

    run(env: AgenticEnvironment): Promise<StoryOutcome> {
        if (this.startedAt != null) return this.done
        this.envRef = env
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    abort(): void {
        this.abortWithReason("story was aborted")
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            source === this.opts.runtimeReplanDecisionAuthority &&
            (RuntimeReplanApplied.is(event) || RuntimeReplanRejected.is(event))
        ) {
            const pending = this.pendingRuntimeReplans.get(event.data.proposalId)
            if (
                pending &&
                this.matchesRuntimeReplanDecision(event.data) &&
                event.data.baseGraphVersion === pending.baseGraphVersion &&
                (RuntimeReplanApplied.is(event)
                    ? event.data.previousGraphVersion === pending.baseGraphVersion
                    : true)
            ) {
                pending.resolve(
                    RuntimeReplanApplied.is(event)
                        ? { status: "applied", data: event.data }
                        : { status: "rejected", data: event.data },
                )
            }
            return
        }
        if (
            AgentTargetedMessage.is(event) &&
            acceptsTargetedMessage(
                source,
                event.data,
                this.spec.id,
                this.spec.targetedMessageAuthority,
                this.spec,
            )
        ) {
            // In reviewed collective execution Critique itself is the
            // authoritative feedback. Ignore its compatibility twin so the
            // same correction is not injected twice.
            if (
                this.spec.requiresQualityReview &&
                (source === this.opts.turnReviewAuthority ||
                    source === this.spec.targetedMessageAuthority) &&
                typeof event.data.metadata.terminalId === "string"
            ) return
            this.turnMessages.deliver(event.data.text)
            return
        }
        if (
            this.spec.requiresQualityReview &&
            source === this.opts.turnReviewAuthority &&
            Critique.is(event) &&
            event.data.agentId === this.spec.id &&
            event.data.terminalId
        ) {
            this.turnReviews.deliver(event.data)
        }
    }

    private matchesRuntimeReplanDecision(
        data: RuntimeReplanAppliedData | RuntimeReplanRejectedData,
    ): boolean {
        return (
            data.runId === this.spec.runId &&
            data.sourceStoryId === this.spec.id &&
            data.leaseId === this.spec.leaseId &&
            data.generation === this.spec.generation
        )
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastError: string | null = null
        let lastFailure: StoryFailureData | undefined
        let attempts = 0

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      lastError = `hard timeout (${this.spec.hardTimeoutSecs}s) hit`
                      this.abortWithReason(lastError)
                  }, this.spec.hardTimeoutSecs * 1000)
                : null

        for (let i = 0; i < maxAttempts; i++) {
            if (this.abortController.signal.aborted) break
            if (i > 0) {
                this.transition("waiting", `retrying (attempt ${i + 1}/${maxAttempts})`)
                try {
                    await this.withAbort(sleep(this.spec.retryDelayMs))
                } catch {
                    break
                }
                if (this.abortController.signal.aborted) break
            }

            attempts += 1
            const attemptTimer =
                this.spec.timeoutSecs > 0
                    ? setTimeout(
                          () =>
                              this.abortWithReason(
                                  `attempt ${attempts} timeout after ${this.spec.timeoutSecs}s`,
                                  {
                                      kind: "infrastructure",
                                      code: "command_timeout",
                                  },
                              ),
                          this.spec.timeoutSecs * 1000,
                      )
                    : null
            try {
                const result = await this.runOneAttempt(attempts)
                if (this.currentPhase === "done") {
                    lastError = null
                    lastFailure = undefined
                    break
                }
                lastFailure = result.failure
                lastError =
                    result.error || "attempt did not reach a terminal state"
                if (
                    result.retryable === false ||
                    boardOwnsRecovery(result.failure)
                ) break
            } catch (e) {
                lastFailure = classifyStoryFailure(e)
                const detail = compactProviderFailureDetail(e)
                lastError = lastFailure
                    ? `${failureSummary(lastFailure)}${detail ? `: ${detail}` : ""}`
                    : detail || "OpenAI story attempt failed"
                this.transition("failed", lastError)
                if (boardOwnsRecovery(lastFailure)) break
            } finally {
                if (attemptTimer) clearTimeout(attemptTimer)
            }
        }

        if (hardTimer) clearTimeout(hardTimer)
        if (this.abortController.signal.aborted) {
            lastError = this.abortReason ?? "story was aborted"
            lastFailure ??= this.abortFailure
        }

        const durationSecs = this.startedAt
            ? Math.round((Date.now() - this.startedAt) / 1000)
            : 0
        const success = this.currentPhase === "done"

        this.envRef?.deliverSemanticEvent(
            this.resultAuthority ?? this,
            StoryResult.create({
                storyId: this.spec.id,
                success,
                attempts,
                durationSecs,
                error: lastError,
                ...(lastFailure ? { failure: lastFailure } : {}),
                ...correlationOf(this.spec),
            }),
        )

        this.resolveDone({
            storyId: this.spec.id,
            success,
            attempts,
            durationSecs,
            finalSummary: null,
            error: lastError,
            ...(lastFailure ? { failure: lastFailure } : {}),
        })
    }

    private async runOneAttempt(attempt: number): Promise<{
        error: string
        failure?: StoryFailureData
        retryable?: boolean
    }> {
        // Echo the prompt on the bus so Cartographer renders it the same
        // way as the Claude side's user echoes.
        const userMessageText = this.spec.prompt
        this.envRef?.deliverSemanticEvent(
            this,
            AgentUserMessage.create({
                agentId: this.spec.id,
                text: userMessageText,
            }),
        )

        let context = ModelContext.create(this.spec.id)
            .addContextItem(SystemMessageItem.create(this.storySystemPrompt()))
            .addContextItem(UserMessageItem.create(userMessageText))

        this.transition("running", "first turn")

        for (let turn = 1; turn <= this.spec.maxTurns; turn++) {
            const turnResult = await this.runOneTurn(context, attempt, turn)
            context = turnResult.context

            // End-of-turn AgentResult is what fires Critic. `usage` is the
            // per-turn round sum, same snake_case shape as Claude's
            // stream-json mapper produces.
            const usageJson = turnResult.usage.isEmpty ? null : turnResult.usage.toJSON()
            const terminalId = this.nextTerminalId(attempt, turn)
            this.envRef?.deliverSemanticEvent(
                this,
                AgentResult.create({
                    agentId: this.spec.id,
                    terminalId,
                    subtype: turnResult.success ? "success" : "error",
                    sessionId: null,
                    isError: !turnResult.success,
                    resultText: turnResult.assistantText,
                    usage: usageJson,
                    totalCostUsd: null,
                    numTurns: null,
                    durationMs: null,
                }),
            )
            process.stderr.write(
                `[story-openai/${this.spec.id}] turn ${turn}: ${turnResult.usage.summary()}\n`,
            )

            if (!turnResult.success) {
                const error = turnResult.error ?? "turn failed"
                if (!this.abortController.signal.aborted) {
                    this.transition("failed", error)
                }
                return {
                    error,
                    ...(turnResult.failure ? { failure: turnResult.failure } : {}),
                    ...(turnResult.retryable === false
                        ? { retryable: false }
                        : {}),
                }
            }

            if (this.spec.requiresQualityReview) {
                const reviewWait = await this.turnReviews.waitFor(terminalId, {
                    timeoutMs: this.opts.turnReviewTimeoutMs,
                    signal: this.abortController.signal,
                })
                if (this.abortController.signal.aborted) {
                    return {
                        error: this.abortReason ?? "story was aborted",
                        retryable: false,
                    }
                }
                if (reviewWait.kind === "timeout") {
                    if (
                        this.spec.handoffInconclusiveToAcceptanceGate === true
                    ) {
                        this.transition(
                            "done",
                            `${turn} turn(s); missing review handed to AcceptanceGate`,
                        )
                        return { error: "" }
                    }
                    return {
                        ...turnReviewTimeoutFailure(
                            terminalId,
                            this.opts.turnReviewTimeoutMs,
                        ),
                        retryable: false,
                    }
                }
                if (reviewWait.kind === "cancelled") {
                    return {
                        error: this.abortReason ?? "story was aborted",
                        retryable: false,
                    }
                }
                const review = reviewWait.review
                const disposition = turnReviewDisposition(terminalId, review, {
                    handoffInconclusiveToAcceptanceGate:
                        this.spec.handoffInconclusiveToAcceptanceGate === true,
                })
                if (disposition.kind === "failure") {
                    return {
                        error: disposition.error,
                        failure: disposition.failure,
                        retryable: false,
                    }
                }
                if (disposition.kind === "pass") {
                    this.transition("done", `${turn} reviewed turn(s)`)
                    return { error: "" }
                }
                if (disposition.kind === "handoff") {
                    this.transition(
                        "done",
                        `${turn} turn(s); inconclusive review handed to AcceptanceGate`,
                    )
                    return { error: "" }
                }
                const feedback = disposition.feedback
                context = context.addContextItem(UserMessageItem.create(feedback))
                this.envRef?.deliverSemanticEvent(
                    this,
                    AgentUserMessage.create({
                        agentId: this.spec.id,
                        text: feedback,
                    }),
                )
                continue
            }

            const message = await this.turnMessages.waitForNext({
                timeoutMs: this.spec.quietTimeoutMs,
                signal: this.abortController.signal,
            })
            if (this.abortController.signal.aborted) {
                return {
                    error: this.abortReason ?? "story was aborted",
                    retryable: false,
                }
            }
            if (message === null) {
                this.transition("done", `${turn} turn(s)`)
                return { error: "" }
            }
            context = context.addContextItem(
                UserMessageItem.create(message),
            )
            this.envRef?.deliverSemanticEvent(
                this,
                AgentUserMessage.create({
                    agentId: this.spec.id,
                    text: message,
                }),
            )
        }

        this.transition("failed", `maxTurns (${this.spec.maxTurns}) exhausted`)
        return {
            error: `maxTurns (${this.spec.maxTurns}) exhausted`,
            failure: {
                kind: "execution",
                code: this.spec.requiresQualityReview
                    ? "quality_rejected"
                    : "turn_limit",
            },
        }
    }

    private nextTerminalId(attempt: number, turn: number): string {
        this.terminalSequence += 1
        return [
            "openai",
            this.spec.runId ?? "local",
            this.spec.leaseId ?? "unleased",
            this.spec.generation ?? "legacy",
            this.spec.id,
            this.terminalProducerId,
            attempt,
            turn,
            this.terminalSequence,
        ]
            .map(String)
            .map(encodeURIComponent)
            .join(":")
    }

    private runtimeReplanEnabled(): boolean {
        return Boolean(
            this.opts.runtimeReplanDecisionAuthority &&
            this.spec.runId &&
            this.spec.leaseId &&
            Number.isInteger(this.spec.generation) &&
            this.spec.generation! >= 0 &&
            this.runtimeGraphVersion !== null,
        )
    }

    private storySystemPrompt(): string {
        if (!this.runtimeReplanEnabled()) return STORY_SYSTEM_PROMPT
        return [
            STORY_SYSTEM_PROMPT,
            "",
            "Runtime DAG adaptation is available through the closed-schema propose_replan tool; Baro validates its arguments locally and fails closed.",
            `Your launch graphVersion is ${this.spec.graphVersion}; the current default baseGraphVersion is ${this.runtimeGraphVersion}. Pass the current value unless a prior tool result reports a newer graphVersion.`,
            "Use it only for genuinely required unplanned work or safe changes to not-yet-started stories. The Board validates and persists every proposal; continue only from the structured applied/rejected tool result.",
        ].join("\n")
    }

    /**
     * One TURN: repeated inference rounds with tool execution in between,
     * until the model returns an assistant message with no tool calls.
     */
    private async runOneTurn(
        initialContext: ModelContext,
        attempt: number,
        turn: number,
    ): Promise<{
        context: ModelContext
        success: boolean
        assistantText: string | null
        usage: UsageAccumulator
        error?: string
        failure?: StoryFailureData
        retryable?: boolean
    }> {
        let context = initialContext
        let assistantText: string | null = null
        const perRoundMs = this.opts.perRoundTimeoutSecs * 1000
        const maxExplorationRounds =
            this.opts.maxRoundsPerTurn - this.opts.finalizationRoundsPerTurn
        let finalizationRequested = false
        // Accumulates across all rounds in the turn; the AgentResult ships the sum.
        const usage = new UsageAccumulator()

        for (let round = 1; round <= this.opts.maxRoundsPerTurn; round++) {
            if (this.currentPhase === "aborted") {
                return {
                    context,
                    success: false,
                    assistantText,
                    usage,
                    error: this.abortReason ?? "story was aborted",
                    retryable: false,
                }
            }
            const calls: FunctionCallItem[] = []
            const toolsAllowed = !finalizationRequested
            let sawMessage = false
            let lastMessageText: string | null = null

            try {
                const result = await this.runRoundWithTransportRetries(
                    context,
                    attempt,
                    turn,
                    round,
                    perRoundMs,
                )
                usage.add(result.usage)

                for (const item of result.items) {
                    if (item.type === "function_call") {
                        if (toolsAllowed) {
                            await this.envRef?.deliverFunctionCall(
                                this,
                                item as FunctionCallItem,
                            )
                        }
                        context = context.addContextItem(item)
                        calls.push(item as FunctionCallItem)
                    } else if (item.type === "message") {
                        await this.envRef?.deliverModelMessage(this, item as ModelMessageItem)
                        context = context.addContextItem(item)
                        const json = (item as ModelMessageItem).toJSON() as {
                            content: Array<{ text: string }>
                        }
                        const text = json.content?.[0]?.text ?? ""
                        lastMessageText = text
                        sawMessage = true
                    } else if (item.type === "reasoning") {
                        context = context.addContextItem(item)
                    }
                }
            } catch (e) {
                if (this.abortController.signal.aborted) {
                    return {
                        context,
                        success: false,
                        assistantText,
                        usage,
                        error: this.abortReason ?? "story was aborted",
                        retryable: false,
                    }
                }
                if (e instanceof InferenceRoundTimeoutError) {
                    return {
                        context,
                        success: false,
                        assistantText,
                        usage,
                        error: e.message,
                        failure: {
                            kind: "transport",
                            code: "request_timeout",
                        },
                        // Mozaik 3.12 does not expose a provider AbortSignal.
                        // Do not overlap a retry with the still-settling request.
                        retryable: false,
                    }
                }
                const failure = classifyStoryFailure(e)
                const detail = compactProviderFailureDetail(e)
                return {
                    context,
                    success: false,
                    assistantText,
                    usage,
                    error: failure
                        ? `${failureSummary(failure)} in inference round ${round}${detail ? `: ${detail}` : ""}`
                        : `inference round ${round} failed${detail ? `: ${detail}` : ""}`,
                    ...(failure ? { failure } : {}),
                }
            }

            const interceptedReplans = this.runtimeReplanEnabled()
                ? calls.filter((call) => call.name === "propose_replan")
                : []
            const ordinaryCalls = calls.filter(
                (call) => !interceptedReplans.includes(call),
            )
            const outputs = new Map<string, string>()
            let ordinaryToolsAllowed = true
            let controlPlaneOutcomeUnknown = false
            // Control-plane calls execute first even when the provider emitted an
            // ordinary write before them. Their outputs are buffered, however,
            // and appended to the model context in the provider's original call
            // order. Some OpenAI-compatible servers require that ordering.
            for (const call of interceptedReplans) {
                const output = toolsAllowed
                    ? await this.proposeRuntimeReplan(call)
                    : finalizationToolOutput(call.name)
                outputs.set(call.callId, output)
                if (!toolsAllowed) continue
                const status = runtimeToolStatus(output)
                ordinaryToolsAllowed =
                    ordinaryToolsAllowed && status === "applied"
                controlPlaneOutcomeUnknown =
                    controlPlaneOutcomeUnknown ||
                    status === "timed_out" ||
                    status === "cancelled"
            }
            for (const call of ordinaryCalls) {
                let output: string
                if (!toolsAllowed) {
                    output = finalizationToolOutput(call.name)
                } else if (!ordinaryToolsAllowed) {
                    output = runtimeReplanToolOutput("skipped", {
                        code: "replan_not_applied",
                        reason:
                            "Ordinary tool execution in this inference batch was skipped because its runtime replan was not applied. Reconsider the Board decision in the next round.",
                    })
                } else if (this.abortController.signal.aborted) {
                    output = this.cancelledToolOutput()
                } else {
                    output = await this.withAbort(
                        this.runOrdinaryTool(call),
                    ).catch(() => this.cancelledToolOutput())
                }
                outputs.set(call.callId, output)
            }
            for (const call of calls) {
                const output = outputs.get(call.callId)
                if (output === undefined) {
                    throw new Error(
                        `missing buffered output for function call ${call.callId}`,
                    )
                }
                const outItem = FunctionCallOutputItem.create(call.callId, output)
                if (toolsAllowed) {
                    await this.envRef?.deliverFunctionCallOutput(this, outItem)
                }
                context = context.addContextItem(outItem)
            }

            if (
                controlPlaneOutcomeUnknown ||
                this.abortController.signal.aborted
            ) {
                return {
                    context,
                    success: false,
                    assistantText,
                    usage,
                    error: this.abortController.signal.aborted
                        ? this.abortReason ?? "story was aborted"
                        : "runtime replan outcome is unknown; refusing to continue against a potentially stale graph",
                    retryable: false,
                }
            }

            if (sawMessage && calls.length === 0) {
                return {
                    context,
                    success: true,
                    assistantText: lastMessageText,
                    usage,
                }
            }

            // Defensive: neither message nor calls shouldn't happen
            // (Mozaik-level invariant), but abort rather than loop forever.
            if (!sawMessage && calls.length === 0) {
                return {
                    context,
                    success: false,
                    assistantText,
                    usage,
                    error: `round ${round} returned no items`,
                }
            }

            if (
                !finalizationRequested &&
                round >= maxExplorationRounds
            ) {
                finalizationRequested = true
                context = context.addContextItem(
                    UserMessageItem.create(
                        finalStoryInstruction(
                            round,
                            maxExplorationRounds,
                            this.opts.maxRoundsPerTurn,
                        ),
                    ),
                )
            } else if (finalizationRequested) {
                context = context.addContextItem(
                    UserMessageItem.create(finalStoryRepairInstruction()),
                )
            }

            assistantText = lastMessageText ?? assistantText
        }

        return {
            context,
            success: false,
            assistantText,
            usage,
            error: `exceeded maxRoundsPerTurn=${this.opts.maxRoundsPerTurn}`,
        }
    }

    private runRound(
        context: ModelContext,
        attempt: number,
        turn: number,
        round: number,
    ) {
        return runInferenceRound(
            context,
            this.model,
            this.billingCoordinator
                ? {
                      billing: {
                          coordinator: this.billingCoordinator,
                          context: {
                              runId: this.spec.runId ?? null,
                              phase: "story",
                              storyId: this.spec.id,
                              leaseId: this.spec.leaseId ?? null,
                              generation: this.spec.generation ?? null,
                              attempt,
                              turn,
                              round,
                          },
                      },
                  }
                : {},
        )
    }

    private async runRoundWithTransportRetries(
        context: ModelContext,
        attempt: number,
        turn: number,
        round: number,
        perRoundMs: number,
    ): Promise<Awaited<ReturnType<typeof runInferenceRound>>> {
        for (
            let reconnect = 0;
            reconnect <= this.opts.transportRetriesPerRound;
            reconnect++
        ) {
            try {
                const roundPromise = this.runRound(
                    context,
                    attempt,
                    turn,
                    round,
                )
                // A local watchdog cannot cancel Mozaik 3.12's provider
                // request. Never overlap it with a retry while it may settle.
                let roundTimer: ReturnType<typeof setTimeout> | undefined
                const timeoutPromise = new Promise<never>((_, reject) => {
                    roundTimer = setTimeout(
                        () =>
                            reject(
                                new InferenceRoundTimeoutError(
                                    `round ${round} timed out after ${perRoundMs}ms`,
                                ),
                            ),
                        perRoundMs,
                    )
                })
                return await this.withAbort(
                    Promise.race([roundPromise, timeoutPromise]),
                ).finally(() => clearTimeout(roundTimer))
            } catch (error) {
                if (
                    error instanceof InferenceRoundTimeoutError ||
                    this.abortController.signal.aborted
                ) throw error
                const failure = classifyStoryFailure(error)
                if (
                    failure?.kind !== "transport" ||
                    reconnect >= this.opts.transportRetriesPerRound
                ) throw error
                const delay = this.opts.transportRetryDelayMs * 2 ** reconnect
                this.transition(
                    "waiting",
                    `transport reconnect ${reconnect + 1}/${this.opts.transportRetriesPerRound}`,
                )
                await this.withAbort(sleep(delay))
                this.transition("running", `inference round ${round}`)
            }
        }
        throw new Error("unreachable transport retry state")
    }

    private async runOrdinaryTool(call: FunctionCallItem): Promise<string> {
        const tool = this.tools.find((candidate) => candidate.name === call.name)
        return tool
            ? runToolSafely(tool, call.args, this.abortController.signal)
            : `Error: tool '${call.name}' not registered`
    }

    private async proposeRuntimeReplan(call: FunctionCallItem): Promise<string> {
        const parsed = parseRuntimeReplanArgs(call.args)
        if (!parsed.ok) return runtimeReplanToolOutput("invalid", {
            proposalId: this.runtimeProposalId(call.callId),
            code: "invalid_arguments",
            reason: parsed.error,
            currentGraphVersion: this.runtimeGraphVersion,
        })

        const proposalId = this.runtimeProposalId(call.callId)
        const decision = new Promise<RuntimeReplanDecision>((resolve) => {
            this.pendingRuntimeReplans.set(proposalId, {
                baseGraphVersion: parsed.value.baseGraphVersion,
                resolve,
            })
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(
                () => resolve(null),
                this.opts.runtimeReplanDecisionTimeoutMs,
            )
        })

        try {
            this.envRef?.deliverSemanticEvent(
                this,
                RuntimeReplanProposed.create({
                    runId: this.spec.runId!,
                    proposalId,
                    sourceStoryId: this.spec.id,
                    leaseId: this.spec.leaseId!,
                    generation: this.spec.generation!,
                    baseGraphVersion: parsed.value.baseGraphVersion,
                    reason: parsed.value.reason,
                    mutation: parsed.value.mutation,
                }),
            )
            let result: RuntimeReplanDecision | null
            try {
                result = await this.withAbort(Promise.race([decision, timeout]))
            } catch {
                return runtimeReplanToolOutput("cancelled", {
                    proposalId,
                    code: "story_aborted",
                    reason:
                        "The story was aborted while its runtime replan decision was pending. The proposal outcome may still need audit reconciliation.",
                    currentGraphVersion: this.runtimeGraphVersion,
                })
            }
            if (!result) {
                return runtimeReplanToolOutput("timed_out", {
                    proposalId,
                    code: "decision_timeout",
                    reason:
                        `No correlated runtime replan decision arrived within ` +
                        `${this.opts.runtimeReplanDecisionTimeoutMs}ms.`,
                    currentGraphVersion: this.runtimeGraphVersion,
                })
            }
            if (result.status === "applied") {
                this.updateRuntimeGraphVersion(
                    result.data.currentGraphVersion ?? result.data.graphVersion,
                )
                return runtimeReplanToolOutput("applied", {
                    proposalId,
                    previousGraphVersion: result.data.previousGraphVersion,
                    graphVersion: result.data.graphVersion,
                    currentGraphVersion:
                        result.data.currentGraphVersion ??
                        result.data.graphVersion,
                    reason: result.data.reason,
                })
            }
            this.updateRuntimeGraphVersion(result.data.currentGraphVersion)
            return runtimeReplanToolOutput("rejected", {
                proposalId,
                code: result.data.code,
                reason: result.data.reason,
                currentGraphVersion: result.data.currentGraphVersion,
            })
        } finally {
            if (timer) clearTimeout(timer)
            this.pendingRuntimeReplans.delete(proposalId)
        }
    }

    private runtimeProposalId(callId: string): string {
        return (
            `${this.spec.runId}:runtime-replan:${this.spec.id}:` +
            `${this.spec.leaseId}:${this.spec.generation}:${callId}`
        )
    }

    private cancelledToolOutput(): string {
        return runtimeReplanToolOutput("cancelled", {
            code: "story_aborted",
            reason: this.abortReason ?? "story was aborted",
        })
    }

    private updateRuntimeGraphVersion(graphVersion: number): void {
        this.runtimeGraphVersion = Math.max(
            this.runtimeGraphVersion ?? 1,
            graphVersion,
        )
        const index = this.tools.findIndex(
            (tool) => tool.name === "propose_replan",
        )
        if (index < 0) return
        this.tools[index] = createRuntimeReplanTool(this.runtimeGraphVersion)
        setModelTools(this.model, this.tools)
    }

    private abortWithReason(
        reason: string,
        failure?: StoryFailureData,
    ): void {
        this.abortReason ??= reason
        this.abortFailure ??= failure
        if (!this.abortController.signal.aborted) this.abortController.abort()
        this.transition("aborted", this.abortReason)
    }

    private async withAbort<T>(promise: Promise<T>): Promise<T> {
        const signal = this.abortController.signal
        if (signal.aborted) throw new Error("story aborted")
        let rejectAbort: ((error: Error) => void) | null = null
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject
        })
        const onAbort = () => rejectAbort?.(new Error("story aborted"))
        signal.addEventListener("abort", onAbort, { once: true })
        try {
            return await Promise.race([promise, aborted])
        } finally {
            signal.removeEventListener("abort", onAbort)
        }
    }

    private transition(next: AgentPhase, detail?: string): void {
        if (this.abortController.signal.aborted && next !== "aborted") return
        if (next === this.currentPhase) return
        this.currentPhase = next
        this.envRef?.deliverSemanticEvent(
            this,
            AgentState.create({
                agentId: this.spec.id,
                phase: next,
                detail,
            }),
        )
    }
}

function pickModel(name: string, connection?: OpenAIConnection): GenerativeModel {
    // Per-story endpoints must use GenericOpenAIModel — the built-in gpt-5.x
    // classes bind to OpenAI's own endpoint and can't be redirected.
    if (connection?.baseURL) {
        return new GenericOpenAIModel(name, connection)
    }
    switch (name) {
        case "gpt-5.5":
            return new Gpt55()
        case "gpt-5.4":
            return new Gpt54()
        case "gpt-5.4-mini":
            return new Gpt54Mini()
        case "gpt-5.4-nano":
            return new Gpt54Nano()
        default:
            process.stderr.write(
                `[pickModel] Using model "${name}" as-is with the OpenAI API.\n`,
            )
            return new GenericOpenAIModel(name)
    }
}

function setModelTools(model: GenerativeModel, tools: Tool[]): void {
    const m = model as unknown as { setTools?: (t: Tool[]) => void }
    if (typeof m.setTools !== "function") {
        throw new Error(
            `OpenAIStoryAgent: model ${model.specification.name} does not implement ToolCallingCapability`,
        )
    }
    m.setTools(tools)
}

function boundedRoundCount(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function boundedFinalizationRounds(
    maxRounds: number,
    requestedRounds: number,
): number {
    const requested = boundedRoundCount(requestedRounds)
    // A non-empty turn always gets one executable exploration round. With a
    // one-round turn there is no room to request a separate final response.
    return Math.min(requested, Math.max(0, maxRounds - 1))
}

function finalizationToolOutput(tool: string): string {
    return JSON.stringify({
        ok: false,
        status: "refused",
        code: "tool_budget_closed",
        tool,
        reason:
            "Tool execution is closed for this turn. Return the final story summary without calling tools.",
    })
}

function finalStoryInstruction(
    round: number,
    maxExplorationRounds: number,
    maxRounds: number,
): string {
    return [
        "The tool-execution budget for this turn is now closed.",
        `Exploration round ${round}/${maxExplorationRounds}; ${maxRounds - round} finalization round(s) remain.`,
        "Tool schemas remain visible only for protocol compatibility. Any further tool call, including propose_replan, will be refused without execution.",
        "Do not call tools. Return a brief final summary of the work completed, tests run, and any remaining issue.",
    ].join("\n")
}

function finalStoryRepairInstruction(): string {
    return [
        "The previous tool call was refused because the tool-execution budget is closed.",
        "Do not call tools again, including propose_replan.",
        "Return only a brief final summary of the work completed, tests run, and any remaining issue.",
    ].join("\n")
}

async function runToolSafely(
    tool: Tool,
    argsJson: string,
    signal?: AbortSignal,
): Promise<string> {
    let parsed: unknown
    try {
        parsed = JSON.parse(argsJson)
    } catch (e) {
        return `Error: tool args were not valid JSON: ${(e as Error)?.message ?? String(e)}`
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
    } catch (e) {
        return `Error running ${tool.name}: ${(e as Error)?.message ?? String(e)}`
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms))
}

function runtimeToolStatus(output: string): string | null {
    try {
        const value = JSON.parse(output) as { status?: unknown }
        return typeof value.status === "string" ? value.status : null
    } catch {
        return null
    }
}

class InferenceRoundTimeoutError extends Error {}

function failureSummary(failure: StoryFailureData): string {
    switch (failure.kind) {
        case "provider_capacity":
            return "provider capacity unavailable"
        case "transport":
            return "provider transport failed"
        case "infrastructure":
            return "execution infrastructure failed"
        case "verification":
            return "verification failed"
        case "execution":
            return "story execution failed"
    }
}

function boardOwnsRecovery(failure: StoryFailureData | undefined): boolean {
    return failure !== undefined && failure.kind !== "execution"
}
