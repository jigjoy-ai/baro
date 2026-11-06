/**
 * Mozaik-native inference runtime — the single chokepoint every non-CLI
 * phase (Architect, Planner, Story, Critic, Surgeon) routes per-round
 * inference through. Mozaik's endpoint mappers turn a ModelContext into a
 * Chat Completions or Responses request and the reply back into context
 * items; Baro owns the provider client, so cancellation, transport and
 * billing extensions apply to the call it actually makes. One code path
 * serves real OpenAI and any compatible endpoint (OPENAI_API_KEY /
 * OPENAI_BASE_URL, forwarded by baro's Rust layer).
 */

import { createRequire } from "node:module"

import OpenAI from "openai"

import { streamChatRound, type ChatStreamClient } from "./chat-stream.js"

import {
    ContextItem,
    OpenAIChatCompletions,
    OpenAIResponses,
    ReasoningItem,
    supportedModels,
    TokenUsage,
    type InferenceInput,
    type ModelContext,
    type Tool,
} from "../../runtime/mozaik.js"
import { envFlag } from "../../runtime/env-flag.js"

import type {
    BillingInvocationContext,
    GatewayBillingCoordinator,
    GatewayBillingDispatch,
} from "../../telemetry/billing/index.js"
import type {
    ModelInvocationStatus,
    UnknownMetricReason,
} from "../../telemetry/model-telemetry.js"

/** What one provider call returned, before billing correlation is attached.
 * The Responses path does not report a ceiling stop yet, so it leaves
 * `truncated` unset rather than claiming the answer was complete. */
interface InferredRound {
    contextItems: ContextItem[]
    tokenUsage: TokenUsage | undefined
    truncated?: boolean
}

export interface InferenceRound {
    items: ContextItem[]
    usage: TokenUsage | undefined
    /** The provider stopped at the output ceiling; what came back is a piece. */
    truncated?: boolean
    /** Present only for a call correlated through the trusted Baro Gateway. */
    billingInvocationId: string | null
}

export type InferenceBillingContext = Omit<
    BillingInvocationContext,
    "backend" | "requestedModel"
>

export interface InferenceRoundOptions {
    /** Cancels the actual provider request, not only the caller's wait. */
    readonly signal?: AbortSignal
    /**
     * Proof of life while the round runs. Only a streamed round can produce
     * it; a non-streamed one has nothing to report until it is finished.
     */
    readonly onActivity?: () => void
    readonly billing?: {
        readonly coordinator: GatewayBillingCoordinator
        readonly context: InferenceBillingContext
    }
}

const PROVIDER_CALL_TIMEOUT_CODE = "BARO_PROVIDER_CALL_TIMEOUT"

/**
 * Marks a timeout owned by the provider-call cap. Plain AbortSignal
 * cancellation is intentionally not a timeout: shutdown/turn cancellation
 * must remain distinguishable in runner and billing telemetry.
 */
export function providerCallTimeoutError(
    timeoutMs: number,
    /** What timed out, when the caller can say something more useful than
     * "inference provider call" — a round number, a phase. */
    label = "inference provider call",
): Error {
    const error = new Error(
        `${label} timed out after ${timeoutMs}ms`,
    ) as Error & { code: string }
    error.name = "TimeoutError"
    error.code = PROVIDER_CALL_TIMEOUT_CODE
    return error
}

/**
 * True only for Baro's typed inference-timeout abort reason.
 *
 * A guard rather than a plain boolean: every caller that asks this question
 * then wants the message off it, and narrowing here spares each of them a cast.
 */
export function isProviderCallTimeout(
    reason: unknown,
): reason is Error & { code: string } {
    return typeof reason === "object"
        && reason !== null
        && (reason as { code?: unknown }).code === PROVIDER_CALL_TIMEOUT_CODE
}

/**
 * A per-story endpoint. When omitted, the SDK reads `OPENAI_API_KEY` /
 * `OPENAI_BASE_URL`. `extraBody` carries provider-only request fields; the
 * fields Baro sets itself win over it.
 */
export interface OpenAIConnection {
    baseURL?: string
    apiKey?: string
    extraBody?: Record<string, unknown>
}

export type OpenAIReasoningEffort =
    | "xhigh"
    | "high"
    | "medium"
    | "low"
    | "none"

export interface CreateOpenAIModelOptions {
    /** A non-OpenAI endpoint must use the redirectable generic adapter. */
    readonly connection?: OpenAIConnection
    /** Applied only to OpenAI's own models, which support this field. */
    readonly reasoningEffort?: string
}

/** What a round needs to know about a model. */
export interface InferenceModelSpecification {
    readonly name: string
    readonly supportReasoningEffort: boolean
    readonly supportStreaming: boolean
    readonly contextWindowSize: number
    readonly maxOutputTokens: number
    readonly supportFunctionCalling: boolean
}

/** A model a round runs on: its specification plus the phase's request settings. */
export interface InferenceModel {
    readonly specification: InferenceModelSpecification
    /** Per-story endpoint; the env default when absent. */
    readonly connection?: OpenAIConnection
    setTools(tools: Tool[]): void
    getTools(): Tool[]
    setReasoningEffort(effort: string): void
    getReasoningEffort(): string
    setStreaming(streaming: boolean): void
    getStreaming(): boolean
}

abstract class ConfigurableModel implements InferenceModel {
    abstract readonly specification: InferenceModelSpecification
    private tools: Tool[] = []
    private streaming = false

    constructor(
        readonly connection: OpenAIConnection | undefined,
        private reasoningEffort: string,
    ) {}

    setTools(tools: Tool[]): void {
        this.tools = tools
    }

    getTools(): Tool[] {
        return this.tools
    }

    setReasoningEffort(effort: string): void {
        this.reasoningEffort = effort
    }

    getReasoningEffort(): string {
        return this.reasoningEffort
    }

    setStreaming(streaming: boolean): void {
        this.streaming = streaming
    }

    getStreaming(): boolean {
        return this.streaming
    }
}

/**
 * Any model name, forwarded as-is, which makes any OpenAI-compatible endpoint
 * usable via `--story-model <name>`. Its effort is kept but never sent: the
 * specification says it does not support one.
 */
export class GenericOpenAIModel extends ConfigurableModel {
    readonly specification: InferenceModelSpecification

    constructor(name: string, connection?: OpenAIConnection) {
        super(connection, "medium")
        this.specification = {
            name,
            supportReasoningEffort: false,
            supportStreaming: false,
            contextWindowSize: 128_000,
            // Above anything a healthy phase has produced, below the runaway
            // that cost one: a live Architect wrote a 20.5k-token decision that
            // parsed, and later a 36k one that did not — eleven minutes for a
            // reply nothing could read.
            maxOutputTokens: 32_768,
            supportFunctionCalling: true,
        }
    }
}

/** One of OpenAI's own models, as Mozaik's catalogue describes it. Reasoning starts at "none". */
export class NativeOpenAIModel extends ConfigurableModel {
    readonly specification: InferenceModelSpecification

    constructor(catalogued: (typeof supportedModels)[number]["specification"]) {
        super(undefined, "none")
        this.specification = {
            name: catalogued.name,
            supportReasoningEffort: catalogued.supportsReasoningEffort,
            supportStreaming: catalogued.supportsStreaming,
            contextWindowSize: catalogued.contextWindowSize,
            maxOutputTokens: catalogued.maxOutputTokens,
            supportFunctionCalling: catalogued.supportsFunctionCalling,
        }
    }
}

/**
 * Shared model selection for Architect and its text-only continuation phase.
 * OpenAI's catalogued models on the default endpoint keep their reasoning
 * effort; redirected endpoints and all other names are generic models, which
 * never receive the unsupported reasoning-effort field.
 */
export function createOpenAIModel(
    name: string,
    options: CreateOpenAIModelOptions = {},
): InferenceModel {
    if (
        options.connection &&
        (options.connection.baseURL !== undefined ||
            options.connection.apiKey !== undefined ||
            options.connection.extraBody !== undefined)
    ) {
        return new GenericOpenAIModel(name, options.connection)
    }

    const model = nativeOpenAIModel(name)
    if (!model) {
        process.stderr.write(
            `[createOpenAIModel] Using model "${name}" as-is with the OpenAI API.\n`,
        )
        return new GenericOpenAIModel(name, options.connection)
    }
    if (options.reasoningEffort !== undefined) {
        if (!isOpenAIReasoningEffort(options.reasoningEffort)) {
            throw new RangeError(
                `OpenAI reasoning effort must be one of xhigh, high, medium, low, none; received ${JSON.stringify(options.reasoningEffort)}`,
            )
        }
        model.setReasoningEffort(options.reasoningEffort)
    }
    return model
}

export function nativeOpenAIModel(name: string): NativeOpenAIModel | null {
    const catalogued = supportedModels.find(
        (model) => model.specification.provider === "openai" && model.specification.name === name,
    )
    return catalogued ? new NativeOpenAIModel(catalogued.specification) : null
}

function isOpenAIReasoningEffort(
    value: string,
): value is OpenAIReasoningEffort {
    return value === "xhigh" || value === "high" || value === "medium" ||
        value === "low" || value === "none"
}

// Failed billed requests have no InferenceRound result carrying their
// correlation id. Retain exact, identity-based evidence on the thrown provider
// error so higher-level observers do not publish the same runner measurement.
const billedInferenceFailures = new WeakSet<object>()

export function inferenceFailureMeasurementPublished(error: unknown): boolean {
    return (typeof error === "object" && error !== null) ||
        typeof error === "function"
        ? billedInferenceFailures.has(error)
        : false
}

// Request and reply mapping are Mozaik's; neither endpoint builds its client until asked to call.
const chatMapper = new OpenAIChatCompletions().endpointMapper
const responsesMapper = new OpenAIResponses().endpointMapper

/**
 * One SDK client per endpoint (the client binds key and base URL). A billed
 * call gets a client without the SDK's hidden HTTP retries: a billing
 * invocation is one provider attempt, and Baro owns retry policy.
 */
const providerClients = new Map<string, OpenAI>()

function providerClient(conn: OpenAIConnection | undefined, billed: boolean): OpenAI {
    const key = [conn?.baseURL ?? "", conn?.apiKey ?? "", billed ? "billed" : ""].join("|")
    let client = providerClients.get(key)
    if (!client) {
        client = new OpenAI({
            ...(conn?.baseURL ? { baseURL: conn.baseURL } : {}),
            ...(conn?.apiKey ? { apiKey: conn.apiKey } : {}),
            ...(billed ? { maxRetries: 0 } : {}),
        })
        providerClients.set(key, client)
    }
    return client
}

function inferenceInput(model: InferenceModel, context: ModelContext): InferenceInput {
    return {
        model: model.specification.name,
        context,
        tools: model.getTools(),
        ...(model.specification.supportReasoningEffort
            ? { reasoningEffort: model.getReasoningEffort() }
            : {}),
    }
}

// OpenAI-native families (gpt-*, o-series, chatgpt-*) use the Responses API on
// every endpoint: GPT-6 rejects function tools on chat completions outright,
// and baro's agents always use tools. Everything else (DeepSeek, GLM, MiniMax,
// Qwen, Llama, ...) speaks Chat Completions and has no /v1/responses.
// BARO_OPENAI_CHAT_ONLY=1 keeps gpt-* on chat for a compatible endpoint that
// serves those names without a Responses API.
function isOpenAINativeModel(name: string): boolean {
    return /^(gpt[-\d]|o[1-9]|chatgpt|text-|davinci)/i.test(name.trim())
}

function usesResponsesApi(name: string): boolean {
    return isOpenAINativeModel(name) && process.env.BARO_OPENAI_CHAT_ONLY !== "1"
}

/**
 * One inference round. A `GenericOpenAIModel` carrying a per-story
 * `connection` routes to that endpoint; everything else uses the env default.
 */
export async function runInferenceRound(
    context: ModelContext,
    model: InferenceModel,
    options: InferenceRoundOptions = {},
): Promise<InferenceRound> {
    const conn = model.connection
    const name = model.specification.name
    const endpointBaseUrl = conn?.baseURL ?? process.env.OPENAI_BASE_URL
    const endpointApiKey = conn?.apiKey ?? process.env.OPENAI_API_KEY
    // Build the request before allocating billing correlation so a local
    // error cannot leave an invocation orphaned in the feed.
    const input = inferenceInput(model, context)
    const dispatch = options.billing?.coordinator.prepareDispatch(
        endpointBaseUrl,
        endpointApiKey,
        {
            ...options.billing.context,
            backend: "openai",
            requestedModel: name || null,
        },
    ) ?? null
    const extraBody = billingExtraBody(conn?.extraBody, dispatch)
    const startedAt = Date.now()

    try {
        const response =
            usesResponsesApi(name)
                ? dispatch
                    ? await inferResponsesWithExtension(
                          conn,
                          input,
                          dispatch.requestExtension,
                          options.signal,
                      )
                    : await inferResponsesRound(
                          conn,
                          input,
                          options.signal,
                      )
                : await inferChatRound(
                      input,
                      model.specification.maxOutputTokens,
                      {
                          ...conn,
                          ...(Object.keys(extraBody).length > 0
                              ? { extraBody }
                              : {}),
                      },
                      dispatch !== null,
                      options.signal,
                      options.onActivity,
                  )
        // An adapter may fulfil after ignoring an abort. The abort winner is
        // authoritative: never publish success after its caller's watchdog
        // has already expired or cancelled the provider request.
        if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error("inference provider call aborted")
        }
        if (dispatch && options.billing) {
            await options.billing.coordinator.observeRunner(dispatch, {
                status: "succeeded",
                durationMs: Date.now() - startedAt,
                usage: response.tokenUsage,
            })
        }
        return {
            items: response.contextItems,
            usage: response.tokenUsage,
            // Computed one layer down and dropped here, so every caller saw a
            // complete answer: an Architect wrote its decision to the ceiling
            // twice, 406s each, and was told both times to repair a document
            // it had never finished.
            truncated: response.truncated === true,
            billingInvocationId: dispatch?.record.invocationId ?? null,
        }
    } catch (error) {
        if (dispatch && options.billing) {
            const failure = inferenceFailureAttribution(error, options.signal)
            await options.billing.coordinator.observeRunner(dispatch, {
                status: failure.status,
                durationMs: Date.now() - startedAt,
                missingReason: failure.reason,
            })
            if (
                (typeof error === "object" && error !== null) ||
                typeof error === "function"
            ) {
                billedInferenceFailures.add(error)
            }
        }
        throw error
    }
}

async function inferChatRound(
    input: InferenceInput,
    maxOutputTokens: number,
    connection: OpenAIConnection,
    billed: boolean,
    signal?: AbortSignal,
    onActivity?: () => void,
): Promise<InferredRound> {
    const client = providerClient(connection, billed)
    const body = withOutputCeiling(
        withParallelToolCalls({
            ...(connection.extraBody ?? {}),
            ...chatMapper.toRequest(input),
        }),
        maxOutputTokens,
    )

    if (nativeStreamingEnabled()) {
        const streamed = await streamChatRound(
            client as unknown as ChatStreamClient,
            body,
            {
                ...(signal ? { signal } : {}),
                ...(onActivity ? { onActivity } : {}),
                requestOptions: uncappedTransport(),
            },
        )
        return {
            contextItems: streamed.items,
            tokenUsage: streamed.usage,
            truncated: streamed.truncated,
        }
    }

    const response = await client.chat.completions.create(
        body as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { ...(signal ? { signal } : {}), ...uncappedTransport() },
    )
    const mapped = chatMapper.toResponse(response)
    return {
        contextItems: mapped.items,
        tokenUsage: mapped.tokenUsage,
        truncated: finishedAtCeiling(response),
    }
}

/** The non-streamed shape of the same fact. */
function finishedAtCeiling(response: unknown): boolean {
    const choices = (response as { choices?: Array<{ finish_reason?: string }> })
        ?.choices
    return Array.isArray(choices) && choices[0]?.finish_reason === "length"
}

/**
 * Streaming makes a long generation distinguishable from a hang, which is
 * what every idle watchdog here measures. `0` is the escape hatch for a
 * provider that ignores `stream_options.include_usage`: without those counts
 * a streamed round reports no tokens, and the cost figures depend on them.
 */
export function nativeStreamingEnabled(): boolean {
    return envFlag("BARO_NATIVE_STREAM")
}

/**
 * A working request is never ended by a stopwatch — including one we did not
 * choose.
 *
 * Baro removed its wall-clock caps in 0.82.0 because a visibly working process
 * must not be killed by the clock. Node's fetch then reimposed one nobody
 * declared: undici defaults `headersTimeout` and `bodyTimeout` to 300s
 * (`lib/dispatcher/client.js`: `headersTimeout != null ? headersTimeout :
 * 300e3`). A non-streamed completion sends no header until the whole answer
 * exists, so any single generation longer than five minutes died at 301s —
 * three times in one live run, each costing five minutes of a thirty-minute
 * phase, while the model was answering correctly the whole time.
 *
 * The provider SDK's own timeout is ten minutes and we never reach it. The
 * round's deadline, the phase's budget and the idle watchdog remain; what goes
 * is the transport's opinion about how long an answer may take.
 */
function uncappedTransport(): Pick<OpenAI.RequestOptions, "fetchOptions"> {
    const dispatcher = noTimeoutDispatcher()
    return dispatcher
        ? { fetchOptions: { dispatcher } as OpenAI.RequestOptions["fetchOptions"] }
        : {}
}

let cachedDispatcher: unknown
let dispatcherResolved = false

function noTimeoutDispatcher(): unknown {
    if (dispatcherResolved) return cachedDispatcher
    dispatcherResolved = true
    try {
        // Node ships undici as its fetch; a runtime without it keeps its own
        // defaults rather than failing a round over transport tuning.
        const load = createRequire(import.meta.url)
        const undici = load("undici") as {
            Agent: new (options: Record<string, unknown>) => unknown
        }
        cachedDispatcher = new undici.Agent({
            headersTimeout: 0,
            bodyTimeout: 0,
        })
    } catch {
        cachedDispatcher = undefined
    }
    return cachedDispatcher
}

/** Test seam: what a round hands the provider client for transport. */
export const __testUncappedTransport = uncappedTransport

/**
 * Ask for what the round is already able to receive.
 *
 * Mozaik's chat mapper never sends `parallel_tool_calls`, though its reply mapping
 * turns every `tool_calls` entry into its own item and our loop runs them all.
 * OpenAI defaults it on; an OpenAI-compatible endpoint need not, and a live
 * GLM-5.2 Architect emitted exactly one call in each of sixty rounds — sixty
 * provider round-trips to read sixty files. The flag is only legal alongside
 * tools, and an explicit value from the caller wins.
 */
function withParallelToolCalls(
    body: Record<string, unknown>,
): Record<string, unknown> {
    const tools = body.tools
    if (!Array.isArray(tools) || tools.length === 0) return body
    if (body.parallel_tool_calls !== undefined) return body
    return { ...body, parallel_tool_calls: true }
}

/**
 * State the ceiling instead of inheriting one.
 *
 * Mozaik sends no `max_tokens`, so how long a reply may be is whatever the
 * endpoint happens to default to — unknown to us and different per provider.
 * A live Architect answered with 36k tokens over eleven minutes, and the reply
 * was unparseable when it arrived; nothing had said it was too long, and the
 * host could only report "not valid JSON", which sends the model back to write
 * the whole document again.
 *
 * With a stated ceiling the cut is ours: `finish_reason: "length"` is a fact
 * the caller can act on and tell the model, instead of a malformed answer
 * nobody can explain.
 */
function withOutputCeiling(
    body: Record<string, unknown>,
    ceiling: number,
): Record<string, unknown> {
    if (body.max_tokens !== undefined) return body
    if (ceiling <= 0) return body
    return { ...body, max_tokens: ceiling }
}

function billingExtraBody(
    configured: Record<string, unknown> | undefined,
    dispatch: GatewayBillingDispatch | null,
): Record<string, unknown> {
    // `_baro_billing` is reserved. Static endpoint configuration cannot forge
    // it or leak it to an arbitrary OpenAI-compatible provider.
    const { _baro_billing: _reserved, ...safeConfigured } = configured ?? {}
    return dispatch
        ? { ...safeConfigured, ...dispatch.requestExtension }
        : safeConfigured
}

/** One gateway-only field rides on an otherwise ordinary Responses call. */
async function inferResponsesWithExtension(
    connection: OpenAIConnection | undefined,
    input: InferenceInput,
    extension: GatewayBillingDispatch["requestExtension"],
    signal?: AbortSignal,
): Promise<InferredRound> {
    const response = await providerClient(connection, true).responses.create(
        {
            ...responsesBody(input),
            ...extension,
        } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
        { ...(signal ? { signal } : {}), ...uncappedTransport() },
    )
    return replayableRound(response)
}

async function inferResponsesRound(
    connection: OpenAIConnection | undefined,
    input: InferenceInput,
    signal?: AbortSignal,
): Promise<InferredRound> {
    const response = await providerClient(connection, false).responses.create(
        responsesBody(input) as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
        { ...(signal ? { signal } : {}), ...uncappedTransport() },
    )
    return replayableRound(response)
}

/**
 * Stateless reasoning replay: `store: false` plus the encrypted content hands
 * the model its own reasoning back across tool rounds without depending on
 * anything the provider stored. Each replayed item goes back exactly as the
 * provider sent it (its id included), which Mozaik's mapper does not keep.
 */
const reasoningWire = new WeakMap<ReasoningItem, Record<string, unknown>>()

function responsesBody(input: InferenceInput): Record<string, unknown> {
    const request = responsesMapper.toRequest(input) as Record<string, unknown>
    const replayed = input.context
        .getItems()
        .filter((item): item is ReasoningItem => item instanceof ReasoningItem)
        .map((item) => reasoningWire.get(item))
    let next = 0
    const requestInput = Array.isArray(request.input)
        ? (request.input as Array<{ type?: unknown }>).map((entry) =>
              entry.type === "reasoning" ? replayed[next++] ?? entry : entry,
          )
        : request.input
    return {
        ...request,
        input: requestInput,
        include: ["reasoning.encrypted_content"],
        store: false,
    }
}

interface WireReasoning {
    type?: unknown
    id?: unknown
    summary?: unknown
    encrypted_content?: unknown
}

function replayableRound(response: unknown): InferredRound {
    const output = (response as { output?: unknown }).output
    const wire = Array.isArray(output) ? (output as WireReasoning[]) : []
    const mapped = responsesMapper.toResponse({
        ...(response as object),
        output: wire.filter((item) => item?.type !== "reasoning"),
    })
    const replayable = mapped.items[Symbol.iterator]()
    const items: ContextItem[] = []
    for (const item of wire) {
        if (item?.type === "reasoning") {
            const reasoning = replayableReasoning(item)
            if (reasoning) items.push(reasoning)
            continue
        }
        const next = replayable.next().value as ContextItem | undefined
        if (next) items.push(next)
    }
    return { contextItems: items, tokenUsage: mapped.tokenUsage }
}

/** An item without encrypted content has nothing to replay and is left out. */
function replayableReasoning(wire: WireReasoning): ReasoningItem | null {
    if (typeof wire.encrypted_content !== "string" || !wire.encrypted_content) {
        return null
    }
    const item = ReasoningItem.rehydrate({
        content: undefined,
        encryptedContent: wire.encrypted_content,
        summary: [],
    })
    reasoningWire.set(item, {
        type: "reasoning",
        ...(typeof wire.id === "string" ? { id: wire.id } : {}),
        summary: Array.isArray(wire.summary) ? wire.summary : [],
        encrypted_content: wire.encrypted_content,
    })
    return item
}

function inferenceFailureAttribution(
    error: unknown,
    signal?: AbortSignal,
): {
    status: Extract<
        ModelInvocationStatus,
        "failed" | "timed_out" | "cancelled"
    >
    reason: UnknownMetricReason
} {
    if (signal?.aborted) {
        return isProviderCallTimeout(signal.reason)
            ? { status: "timed_out", reason: "timed_out" }
            : { status: "cancelled", reason: "not_reported" }
    }
    const reason = inferenceFailureReason(error)
    return reason === "timed_out"
        ? { status: "timed_out", reason }
        : { status: "failed", reason }
}

function inferenceFailureReason(error: unknown): UnknownMetricReason {
    if (typeof error !== "object" || error === null) return "not_reported"
    const item = error as Record<string, unknown>
    if (
        (typeof item.name === "string" && /abort/i.test(item.name)) ||
        item.code === "ETIMEDOUT" ||
        (typeof item.message === "string" &&
            /(?:abort|timed?\s*out|timeout)/i.test(item.message))
    ) {
        return "timed_out"
    }
    return "not_reported"
}


export class UsageAccumulator {
    private input = 0
    private output = 0
    private total = 0
    private cached = 0
    private reasoning = 0
    private rounds = 0

    add(usage: TokenUsage | undefined): void {
        if (!usage) return
        this.rounds += 1
        this.input += usage.inputTokens ?? 0
        this.output += usage.outputTokens ?? 0
        this.total += usage.totalTokens ?? 0
        this.cached += usage.inputTokenDetails?.cached_tokens ?? 0
        this.reasoning += usage.outputTokenDetails?.reasoning_tokens ?? 0
    }

    get isEmpty(): boolean {
        return this.rounds === 0
    }

    get totalTokens(): number {
        return this.total
    }

    /** Snake_case keys line up with what the Claude side's stream-json
     *  mapper produces from Anthropic usage frames. */
    toJSON() {
        return {
            input_tokens: this.input,
            output_tokens: this.output,
            total_tokens: this.total,
            cached_input_tokens: this.cached,
            reasoning_tokens: this.reasoning,
            rounds: this.rounds,
        }
    }

    summary(): string {
        if (this.isEmpty) return "(no token usage reported)"
        return (
            `${this.total} total tokens ` +
            `(${this.input} in, ${this.output} out` +
            `${this.cached ? `, ${this.cached} cached` : ""}` +
            `${this.reasoning ? `, ${this.reasoning} reasoning` : ""}` +
            `) across ${this.rounds} round(s)`
        )
    }
}
