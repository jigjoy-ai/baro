/**
 * Mozaik-native inference runtime — the single chokepoint every non-CLI
 * phase (Architect, Planner, Story, Critic, Surgeon) routes per-round
 * inference through. Mozaik's `OpenAICompatibleChatCompletions` speaks
 * Chat Completions against a configurable base URL (the SDK reads
 * OPENAI_API_KEY / OPENAI_BASE_URL, forwarded by baro's Rust layer), so
 * one code path serves real OpenAI and any compatible endpoint. Mozaik
 * owns the ModelContext ⇄ chat-message conversion.
 */

import {
    ContextItem,
    InferenceRequest,
    OpenAICompatibleChatCompletions,
    OpenAIResponses,
    TokenUsage,
    type GenerativeModel,
    type ModelContext,
    type Tool,
} from "@mozaik-ai/core"

import type {
    BillingInvocationContext,
    GatewayBillingCoordinator,
    GatewayBillingDispatch,
} from "../billing/index.js"
import type {
    ModelInvocationStatus,
    UnknownMetricReason,
} from "../model-telemetry.js"

export interface InferenceRound {
    items: ContextItem[]
    usage: TokenUsage | undefined
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
export function providerCallTimeoutError(timeoutMs: number): Error {
    const error = new Error(
        `inference provider call timed out after ${timeoutMs}ms`,
    ) as Error & { code: string }
    error.name = "TimeoutError"
    error.code = PROVIDER_CALL_TIMEOUT_CODE
    return error
}

/** True only for Baro's typed inference-timeout abort reason. */
export function isProviderCallTimeout(reason: unknown): boolean {
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
            maxOutputTokens: 16_384,
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
        }
        throw error
    }
}

async function inferChatRound(
    request: InferenceRequest,
    connection: OpenAIConnection,
    billed: boolean,
    signal?: AbortSignal,
) {
    const runtime = getChatRuntime(connection, !billed)
    if (billed) disableOpenAiSdkRetries(runtime)
    if (!signal) return runtime.infer(request)

    const internals = runtime as unknown as ChatRuntimeInternals
    assertChatRuntimeInternals(internals)
    const response = await internals.client.chat.completions.create(
        internals.buildRequest(request),
        { signal },
    )
    return {
        contextItems: internals.extractContextItems(response),
        tokenUsage: internals.extractTokenUsage(response),
    }
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
): Promise<{ contextItems: ContextItem[]; tokenUsage: TokenUsage | undefined }> {
    const internals = responseInternals(runtime)
    disableOpenAiSdkRetries(runtime)
    const response = await internals.client.responses.create(
        {
            ...internals.buildRequest(request),
            ...extension,
        },
        signal ? { signal } : undefined,
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
): Promise<{ contextItems: ContextItem[]; tokenUsage: TokenUsage | undefined }> {
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
