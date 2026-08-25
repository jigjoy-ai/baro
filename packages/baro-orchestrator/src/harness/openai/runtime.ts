/**
 * Mozaik-native inference runtime — the single chokepoint every non-CLI
 * phase (Architect, Planner, Story, Critic, Surgeon) routes per-round
 * inference through. Mozaik's `OpenAICompatibleChatCompletions` speaks
 * Chat Completions against a configurable base URL (the SDK reads
 * OPENAI_API_KEY / OPENAI_BASE_URL, forwarded by baro's Rust layer), so
 * one code path serves real OpenAI and any compatible endpoint. Mozaik
 * owns the ModelContext ⇄ chat-message conversion.
 */

import { createRequire } from "node:module"

import { streamChatRound, type ChatStreamClient } from "./chat-stream.js"

import {
    ContextItem,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    InferenceRequest,
    OpenAICompatibleChatCompletions,
    OpenAIResponses,
    TokenUsage,
    type GenerativeModel,
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
 * Structurally matches Mozaik's (non-exported) `OpenAICompatibleConfig`.
 * When omitted, the SDK reads `OPENAI_API_KEY` / `OPENAI_BASE_URL`.
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
    /** Applied only to Mozaik-native OpenAI models that support this field. */
    readonly reasoningEffort?: string
}

/**
 * Minimal `GenerativeModel` for names Mozaik doesn't ship — forwarded
 * as-is, which makes any OpenAI-compatible endpoint usable via
 * `--story-model <name>`.
 */
export class GenericOpenAIModel implements GenerativeModel {
    readonly specification: GenerativeModel["specification"]
    /** Per-story endpoint: `runInferenceRound` routes to this baseURL/apiKey
     *  instead of the env default — lets one DAG hit several endpoints. */
    readonly connection?: OpenAIConnection
    private _tools: Tool[] = []
    private _reasoningEffort = "medium"
    private _streaming = false

    constructor(name: string, connection?: OpenAIConnection) {
        this.connection = connection
        this.specification = {
            name,
            supportReasoningEffort: false,
            defaultReasoningEffort: undefined,
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

    setTools(tools: Tool[]): void {
        this._tools = tools
    }

    getTools(): Tool[] {
        return this._tools
    }

    // Effectively no-ops: with `supportReasoningEffort: false` the runtime
    // sends no reasoning_effort field for a generic chat model.
    setReasoningEffort(effort: string): void {
        this._reasoningEffort = effort
    }

    getReasoningEffort(): string {
        return this._reasoningEffort
    }

    setStreaming(streaming: boolean): void {
        this._streaming = streaming
    }

    getStreaming(): boolean {
        return this._streaming
    }
}

/**
 * Shared model selection for Architect and its text-only continuation phase.
 * Recognized OpenAI models use Mozaik's native Responses-capable classes on
 * the default endpoint; redirected endpoints and all other model names remain
 * generic Chat Completions models. Generic models deliberately never receive
 * an unsupported reasoning-effort request field.
 */
export function createOpenAIModel(
    name: string,
    options: CreateOpenAIModelOptions = {},
): GenerativeModel {
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

function nativeOpenAIModel(
    name: string,
): Gpt55 | Gpt54 | Gpt54Mini | Gpt54Nano | null {
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
            return null
    }
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

// One runtime per distinct endpoint: the vendor SDK client binds key +
// base URL at construction. The empty key is the default env-driven endpoint.
const chatRuntimeCache = new Map<string, OpenAICompatibleChatCompletions>()

function getChatRuntime(
    conn?: OpenAIConnection,
    cache = true,
): OpenAICompatibleChatCompletions {
    const key = [
        conn?.baseURL ?? "",
        conn?.apiKey ?? "",
        JSON.stringify(conn?.extraBody ?? {}),
    ].join("|")
    if (!cache) {
        return new OpenAICompatibleChatCompletions({
            baseURL: conn?.baseURL,
            apiKey: conn?.apiKey,
            extraBody: conn?.extraBody,
        })
    }
    let rt = chatRuntimeCache.get(key)
    if (!rt) {
        rt =
            conn?.baseURL || conn?.apiKey || conn?.extraBody
                ? new OpenAICompatibleChatCompletions({
                      baseURL: conn.baseURL,
                      apiKey: conn.apiKey,
                      extraBody: conn.extraBody,
                  })
                : new OpenAICompatibleChatCompletions()
        chatRuntimeCache.set(key, rt)
    }
    return rt
}

// The Responses API runtime is env-driven, so one shared instance suffices.
let responsesRuntime: OpenAIResponses | undefined
function getResponsesRuntime(): OpenAIResponses {
    if (!responsesRuntime) responsesRuntime = new OpenAIResponses()
    return responsesRuntime
}

// OpenAI-native families (gpt-*, o-series, chatgpt-*) must use the Responses
// API: OpenAI rejects function tools + reasoning_effort on chat completions,
// and baro's agents always use tools. Everything else (DeepSeek, MiniMax,
// Qwen, Llama, ...) speaks Chat Completions and has no /v1/responses.
function isOpenAINativeModel(name: string): boolean {
    return /^(gpt[-\d]|o[1-9]|chatgpt|text-|davinci)/i.test(name.trim())
}

/**
 * One inference round. A `GenericOpenAIModel` carrying a per-story
 * `connection` routes to that endpoint; everything else uses the env default.
 */
export async function runInferenceRound(
    context: ModelContext,
    model: GenerativeModel,
    options: InferenceRoundOptions = {},
): Promise<InferenceRound> {
    const conn = (model as Partial<GenericOpenAIModel>).connection
    const name = model.specification?.name ?? ""
    const endpointBaseUrl = conn?.baseURL ?? process.env.OPENAI_BASE_URL
    const endpointApiKey = conn?.apiKey ?? process.env.OPENAI_API_KEY
    // Construct the Mozaik request before allocating billing correlation so a
    // local validation error cannot leave an invocation orphaned in the feed.
    const request = new InferenceRequest(model, context)
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
            isOpenAINativeModel(name) && !conn?.baseURL
                ? dispatch
                    ? await inferResponsesWithExtension(
                          getResponsesRuntime(),
                          request,
                          dispatch.requestExtension,
                          options.signal,
                      )
                    : await inferResponsesRound(
                          getResponsesRuntime(),
                          request,
                          options.signal,
                      )
                : await inferChatRound(
                      request,
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
    request: InferenceRequest,
    connection: OpenAIConnection,
    billed: boolean,
    signal?: AbortSignal,
    onActivity?: () => void,
) {
    const runtime = getChatRuntime(connection, !billed)
    if (billed) disableOpenAiSdkRetries(runtime)

    const internals = runtime as unknown as ChatRuntimeInternals
    assertChatRuntimeInternals(internals)
    const body = withOutputCeiling(
        withParallelToolCalls(internals.buildRequest(request)),
        request,
    )

    if (nativeStreamingEnabled()) {
        const streamed = await streamChatRound(
            internals.client as unknown as ChatStreamClient,
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

    const response = await internals.client.chat.completions.create(body, {
        ...(signal ? { signal } : {}),
        ...uncappedTransport(),
    })
    return {
        contextItems: internals.extractContextItems(response),
        tokenUsage: internals.extractTokenUsage(response),
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
function uncappedTransport(): { fetchOptions: { dispatcher: unknown } } | Record<string, never> {
    const dispatcher = noTimeoutDispatcher()
    return dispatcher ? { fetchOptions: { dispatcher } } : {}
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
 * Mozaik 3.12 never sends `parallel_tool_calls`, though its response reader
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
    request: InferenceRequest,
): Record<string, unknown> {
    if (body.max_tokens !== undefined) return body
    const ceiling = (
        request.model as { specification?: { maxOutputTokens?: number } }
    ).specification?.maxOutputTokens
    if (typeof ceiling !== "number" || ceiling <= 0) return body
    return { ...body, max_tokens: ceiling }
}

interface ProviderRequestOptions {
    signal?: AbortSignal
}

interface ChatRuntimeInternals {
    client: {
        chat: {
            completions: {
                create(
                    body: Record<string, unknown>,
                    options?: ProviderRequestOptions,
                ): Promise<unknown>
            }
        }
    }
    buildRequest(input: InferenceRequest): Record<string, unknown>
    extractContextItems(response: unknown): ContextItem[]
    extractTokenUsage(response: unknown): TokenUsage | undefined
}

function assertChatRuntimeInternals(
    internals: ChatRuntimeInternals,
): void {
    if (
        !internals.client?.chat?.completions ||
        typeof internals.buildRequest !== "function" ||
        typeof internals.extractContextItems !== "function" ||
        typeof internals.extractTokenUsage !== "function"
    ) {
        throw new Error(
            "Mozaik Chat Completions runtime cannot attach provider cancellation",
        )
    }
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

/**
 * Mozaik 3.12 does not yet expose request extensions on its Responses
 * adapter. Reuse its own request construction and response mapping while
 * inserting the one gateway-only field at this single interception point.
 */
async function inferResponsesWithExtension(
    runtime: OpenAIResponses,
    request: InferenceRequest,
    extension: GatewayBillingDispatch["requestExtension"],
    signal?: AbortSignal,
): Promise<InferredRound> {
    const internals = responseInternals(runtime)
    disableOpenAiSdkRetries(runtime)
    const response = await internals.client.responses.create(
        {
            ...internals.buildRequest(request),
            ...extension,
        },
        { ...(signal ? { signal } : {}), ...uncappedTransport() },
    )
    return {
        contextItems: internals.extractContextItems(response),
        tokenUsage: internals.extractTokenUsage(response),
    }
}

async function inferResponsesRound(
    runtime: OpenAIResponses,
    request: InferenceRequest,
    signal?: AbortSignal,
): Promise<InferredRound> {
    if (!signal) {
        const response = await runtime.infer(request)
        return {
            contextItems: response.contextItems,
            tokenUsage: response.tokenUsage,
        }
    }
    const internals = responseInternals(runtime)
    const response = await internals.client.responses.create(
        internals.buildRequest(request),
        { signal },
    )
    return {
        contextItems: internals.extractContextItems(response),
        tokenUsage: internals.extractTokenUsage(response),
    }
}

interface ResponsesRuntimeInternals {
    client: {
        responses: {
            create(
                body: Record<string, unknown>,
                options?: ProviderRequestOptions,
            ): Promise<unknown>
        }
    }
    buildRequest(input: InferenceRequest): Record<string, unknown>
    extractContextItems(response: unknown): ContextItem[]
    extractTokenUsage(response: unknown): TokenUsage | undefined
}

function responseInternals(
    runtime: OpenAIResponses,
): ResponsesRuntimeInternals {
    const internals = runtime as unknown as ResponsesRuntimeInternals
    if (
        !internals.client?.responses ||
        typeof internals.buildRequest !== "function" ||
        typeof internals.extractContextItems !== "function" ||
        typeof internals.extractTokenUsage !== "function"
    ) {
        throw new Error(
            "Mozaik Responses runtime cannot attach trusted request controls",
        )
    }
    return internals
}

/**
 * A billing invocation is one provider attempt. Baro owns higher-level retry
 * policy and allocates a fresh invocation ID for each explicit reconnect; the
 * OpenAI SDK's hidden HTTP retries would otherwise reuse one ID for multiple
 * upstream calls. Mozaik 3.12 keeps the SDK client private, so this adapter is
 * deliberately fail-closed and covered by a version-pinned integration test.
 */
function disableOpenAiSdkRetries(
    runtime: OpenAICompatibleChatCompletions | OpenAIResponses,
): void {
    const internals = runtime as unknown as {
        client?: { maxRetries?: number }
    }
    if (!internals.client || typeof internals.client.maxRetries !== "number") {
        throw new Error(
            "Mozaik OpenAI runtime cannot enforce one HTTP attempt per billing invocation",
        )
    }
    internals.client.maxRetries = 0
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
