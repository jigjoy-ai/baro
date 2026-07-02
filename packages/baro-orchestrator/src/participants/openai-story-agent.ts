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
    StoryResult,
    type AgentPhase,
} from "../semantic-events.js"
import { type StoryOutcome, type StorySpec } from "./story-agent.js"

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
    perRoundTimeoutSecs?: number
    /**
     * Per-story OpenAI-compatible endpoint. Overrides the process-global
     * `OPENAI_BASE_URL` for this story only and forces `GenericOpenAIModel`
     * (the built-in gpt-5.x classes are hard-wired to OpenAI). Lets one run
     * mix endpoints (e.g. MiniMax + real OpenAI).
     */
    baseUrl?: string
    /** API key paired with `baseUrl`. */
    apiKey?: string
}

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
    private readonly opts: Required<OpenAIStoryAgentOptions>
    private readonly model: GenerativeModel
    private readonly tools: Tool[]

    private envRef: AgenticEnvironment | null = null
    private currentPhase: AgentPhase = "idle"
    private startedAt: number | null = null
    private resolveDone!: (outcome: StoryOutcome) => void
    public readonly done: Promise<StoryOutcome>

    private notifyMessage: (() => void) | null = null
    /** Set alongside notifyMessage when a targeted message arrives. */
    private pendingMessage: string | null = null

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
        this.opts = {
            model: opts.model ?? "gpt-5.5",
            maxRoundsPerTurn: opts.maxRoundsPerTurn ?? 30,
            perRoundTimeoutSecs: opts.perRoundTimeoutSecs ?? 180,
            baseUrl: opts.baseUrl ?? "",
            apiKey: opts.apiKey ?? "",
        }
        const connection: OpenAIConnection | undefined = opts.baseUrl
            ? { baseURL: opts.baseUrl, apiKey: opts.apiKey }
            : undefined
        this.model = pickModel(this.opts.model, connection)
        this.tools = createStoryTools(spec.cwd)
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

    run(env: AgenticEnvironment): Promise<StoryOutcome> {
        if (this.startedAt != null) return this.done
        this.envRef = env
        this.startedAt = Date.now()
        this.transition("starting", "story queued")
        void this.executeAllAttempts()
        return this.done
    }

    abort(): void {
        this.transition("aborted", "external abort")
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (
            AgentTargetedMessage.is(event) &&
            event.data.recipientId === this.spec.id
        ) {
            this.pendingMessage = event.data.text
            this.notifyMessage?.()
        }
    }

    private async executeAllAttempts(): Promise<void> {
        const maxAttempts = this.spec.retries + 1
        let lastError: string | null = null
        let attempts = 0

        const hardTimer =
            this.spec.hardTimeoutSecs > 0
                ? setTimeout(() => {
                      lastError = `hard timeout (${this.spec.hardTimeoutSecs}s) hit`
                      this.transition("aborted", lastError)
                  }, this.spec.hardTimeoutSecs * 1000)
                : null

        for (let i = 0; i < maxAttempts; i++) {
            attempts = i + 1
            if (this.currentPhase === "aborted") break
            if (i > 0) {
                // AgentPhase has no retry state; re-use "starting" with the
                // attempt number in the detail string.
                this.transition("starting", `retry ${attempts}/${maxAttempts}`)
                await sleep(this.spec.retryDelayMs)
            }

            try {
                await this.runOneAttempt()
                if (this.currentPhase === "done") {
                    lastError = null
                    break
                }
                lastError = "attempt did not reach a terminal state"
            } catch (e) {
                lastError = (e as Error)?.message ?? String(e)
                this.transition("failed", lastError)
            }
        }

        if (hardTimer) clearTimeout(hardTimer)

        const durationSecs = this.startedAt
            ? Math.round((Date.now() - this.startedAt) / 1000)
            : 0
        const success = this.currentPhase === "done"

        this.envRef?.deliverSemanticEvent(
            this,
            StoryResult.create({
                storyId: this.spec.id,
                success,
                attempts,
                durationSecs,
                error: lastError,
            }),
        )

        this.resolveDone({
            storyId: this.spec.id,
            success,
            attempts,
            durationSecs,
            finalSummary: null,
            error: lastError,
        })
    }

    private async runOneAttempt(): Promise<void> {
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
            .addContextItem(SystemMessageItem.create(STORY_SYSTEM_PROMPT))
            .addContextItem(UserMessageItem.create(userMessageText))

        this.transition("running", "first turn")

        for (let turn = 1; turn <= this.spec.maxTurns; turn++) {
            const turnResult = await this.runOneTurn(context)
            context = turnResult.context

            // End-of-turn AgentResult is what fires Critic. `usage` is the
            // per-turn round sum, same snake_case shape as Claude's
            // stream-json mapper produces.
            const usageJson = turnResult.usage.isEmpty ? null : turnResult.usage.toJSON()
            this.envRef?.deliverSemanticEvent(
                this,
                AgentResult.create({
                    agentId: this.spec.id,
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
                this.transition("failed", turnResult.error ?? "turn failed")
                return
            }

            const gotMessage = await this.waitForMessageOrQuiet()
            if (!gotMessage) {
                this.transition("done", `${turn} turn(s)`)
                return
            }
            context = context.addContextItem(
                UserMessageItem.create(this.pendingMessage ?? ""),
            )
            this.envRef?.deliverSemanticEvent(
                this,
                AgentUserMessage.create({
                    agentId: this.spec.id,
                    text: this.pendingMessage ?? "",
                }),
            )
            this.pendingMessage = null
        }

        this.transition("failed", `maxTurns (${this.spec.maxTurns}) exhausted`)
    }

    /**
     * One TURN: repeated inference rounds with tool execution in between,
     * until the model returns an assistant message with no tool calls.
     */
    private async runOneTurn(
        initialContext: ModelContext,
    ): Promise<{ context: ModelContext; success: boolean; assistantText: string | null; usage: UsageAccumulator; error?: string }> {
        let context = initialContext
        let assistantText: string | null = null
        const perRoundMs = this.opts.perRoundTimeoutSecs * 1000
        // Accumulates across all rounds in the turn; the AgentResult ships the sum.
        const usage = new UsageAccumulator()

        for (let round = 1; round <= this.opts.maxRoundsPerTurn; round++) {
            const calls: FunctionCallItem[] = []
            let sawMessage = false
            let lastMessageText: string | null = null

            try {
                const roundPromise = runInferenceRound(context, this.model)
                // Clear the timer once the round settles — a pending setTimeout keeps
                // the process alive for the full perRoundMs after the work is done.
                let roundTimer: ReturnType<typeof setTimeout> | undefined
                const timeoutPromise = new Promise<never>((_, rej) => {
                    roundTimer = setTimeout(
                        () => rej(new Error(`round ${round} timed out after ${perRoundMs}ms`)),
                        perRoundMs,
                    )
                })
                const result = await Promise.race([roundPromise, timeoutPromise]).finally(() => clearTimeout(roundTimer))
                usage.add(result.usage)

                for (const item of result.items) {
                    if (item.type === "function_call") {
                        await this.envRef?.deliverFunctionCall(this, item as FunctionCallItem)
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
                return {
                    context,
                    success: false,
                    assistantText,
                    usage,
                    error: `inference round ${round} failed: ${(e as Error)?.message ?? String(e)}`,
                }
            }

            for (const call of calls) {
                const tool = this.tools.find((t) => t.name === call.name)
                const output = tool
                    ? await runToolSafely(tool, call.args)
                    : `Error: tool '${call.name}' not registered`
                const outItem = FunctionCallOutputItem.create(call.callId, output)
                await this.envRef?.deliverFunctionCallOutput(this, outItem)
                context = context.addContextItem(outItem)
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

    /**
     * True if a targeted message arrives within quietTimeoutMs, false if the
     * timer fires first. Mirrors the Claude side's quiet timer.
     */
    private async waitForMessageOrQuiet(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                this.notifyMessage = null
                resolve(false)
            }, this.spec.quietTimeoutMs)

            this.notifyMessage = () => {
                clearTimeout(timer)
                this.notifyMessage = null
                resolve(true)
            }
        })
    }

    private transition(next: AgentPhase, detail?: string): void {
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

async function runToolSafely(tool: Tool, argsJson: string): Promise<string> {
    let parsed: unknown
    try {
        parsed = JSON.parse(argsJson)
    } catch (e) {
        return `Error: tool args were not valid JSON: ${(e as Error)?.message ?? String(e)}`
    }
    try {
        const result = await tool.invoke(parsed)
        return typeof result === "string" ? result : JSON.stringify(result)
    } catch (e) {
        return `Error running ${tool.name}: ${(e as Error)?.message ?? String(e)}`
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms))
}
