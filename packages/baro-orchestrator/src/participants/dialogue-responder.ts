/** Text-only model adapters for DialogueAgent. No repository tools are exposed. */

import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    ModelContext,
    SystemMessageItem,
    UserMessageItem,
    type TokenUsage,
} from "@mozaik-ai/core"

import type { GatewayBillingCoordinator } from "../billing/index.js"
import { runCodexOneShot } from "../codex-one-shot.js"
import { harnessChildEnvironment } from "../harness-environment.js"
import { runOpenCodeOneShot } from "../opencode-one-shot.js"
import { runPiOneShot } from "../pi-one-shot.js"
import {
    GenericOpenAIModel,
    runInferenceRound,
    type OpenAIConnection,
} from "../planning/openai-runtime.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type MetricSource,
    type ModelCostMetrics,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
    type UnknownMetricReason,
} from "../model-telemetry.js"
import type { RunnerInvocationObservation } from "../runner-invocation.js"
import {
    DialogueResponderInvocationError,
    type DialogueResponder,
    type DialogueResponderInvocation,
    type DialogueResponderTelemetry,
} from "./dialogue-agent.js"

export type DialogueBackend =
    | "claude"
    | "openai"
    | "codex"
    | "opencode"
    | "pi"

export interface CreateDialogueResponderOptions {
    backend: DialogueBackend
    cwd: string
    model?: string
    timeoutMs?: number
    claudeBin?: string
    codexBin?: string
    opencodeBin?: string
    piBin?: string
    /** Allow an explicitly isolated caller to run Codex outside a git checkout. */
    codexSkipGitRepoCheck?: boolean
    openaiConnection?: OpenAIConnection
    /** Trusted Gateway receipt correlation for OpenAI dialogue calls. */
    billingCoordinator?: GatewayBillingCoordinator
    /** Narrow protocol-test seam; production uses the shared Mozaik runtime. */
    openaiRunRound?: typeof runInferenceRound
}

export function createDialogueResponder(
    opts: CreateDialogueResponderOptions,
): DialogueResponder {
    if (opts.backend === "openai") return createOpenAIResponder(opts)
    if (opts.backend === "codex") return createCodexResponder(opts)
    if (opts.backend === "opencode") return createOpenCodeResponder(opts)
    if (opts.backend === "pi") return createPiResponder(opts)
    return createClaudeResponder(opts)
}

function createOpenCodeResponder(
    opts: CreateDialogueResponderOptions,
): DialogueResponder {
    const requestedModel = opts.model ?? "opencode-default"
    const telemetry = localHarnessTelemetryDescriptor(
        "opencode",
        requestedModel,
    )
    const responder: DialogueResponder = async (input, signal) => {
        let observation: RunnerInvocationObservation | undefined
        try {
            const text = await withIsolatedHarnessCwd(
                "baro-opencode-dialogue-",
                (cwd) => runOpenCodeOneShot({
                    prompt: input.userPrompt,
                    cwd,
                    model: opts.model,
                    opencodeBin: opts.opencodeBin,
                    timeoutMs: opts.timeoutMs ?? 60_000,
                    label: "opencode-dialogue",
                    safeEvaluatorSystemPrompt: input.systemPrompt,
                    signal,
                    onInvocation: (item) => {
                        observation = item
                    },
                }),
            )
            return {
                text,
                invocation: localHarnessInvocation(
                    "opencode",
                    requestedModel,
                    observation ?? unknownLocalHarnessObservation(
                        "succeeded",
                        "not_reported",
                        "opencode",
                        requestedModel,
                    ),
                ),
            }
        } catch (error) {
            if (isProcessLaunchFailure(error)) {
                throw new Error("OpenCode dialogue process could not start")
            }
            const timedOut = isTimeout(error)
            throw new DialogueResponderInvocationError(
                "OpenCode dialogue provider failed",
                observation
                    ? localHarnessInvocation(
                          "opencode",
                          requestedModel,
                          observation,
                      )
                    : telemetry.failureInvocation(
                          timedOut ? "timed_out" : "failed",
                          timedOut ? "timed_out" : "not_reported",
                      ),
            )
        }
    }
    return Object.assign(responder, { telemetry })
}

function createPiResponder(
    opts: CreateDialogueResponderOptions,
): DialogueResponder {
    const requestedModel = opts.model ?? "pi-default"
    const telemetry = localHarnessTelemetryDescriptor("pi", requestedModel)
    const responder: DialogueResponder = async (input, signal) => {
        let observation: RunnerInvocationObservation | undefined
        try {
            const text = await withIsolatedHarnessCwd(
                "baro-pi-dialogue-",
                (cwd) => runPiOneShot({
                    prompt: input.userPrompt,
                    cwd,
                    model: opts.model,
                    piBin: opts.piBin,
                    timeoutMs: opts.timeoutMs ?? 60_000,
                    label: "pi-dialogue",
                    safeEvaluatorSystemPrompt: input.systemPrompt,
                    signal,
                    onInvocation: (item) => {
                        observation = item
                    },
                }),
            )
            return {
                text,
                invocation: localHarnessInvocation(
                    "pi",
                    requestedModel,
                    observation ?? unknownLocalHarnessObservation(
                        "succeeded",
                        "not_reported",
                        "pi",
                        requestedModel,
                    ),
                ),
            }
        } catch (error) {
            if (isProcessLaunchFailure(error)) {
                throw new Error("Pi dialogue process could not start")
            }
            const timedOut = isTimeout(error)
            throw new DialogueResponderInvocationError(
                "Pi dialogue provider failed",
                observation
                    ? localHarnessInvocation(
                          "pi",
                          requestedModel,
                          observation,
                      )
                    : telemetry.failureInvocation(
                          timedOut ? "timed_out" : "failed",
                          timedOut ? "timed_out" : "not_reported",
                      ),
            )
        }
    }
    return Object.assign(responder, { telemetry })
}

function createCodexResponder(
    opts: CreateDialogueResponderOptions,
): DialogueResponder {
    const requestedModel = opts.model ?? "codex-default"
    const telemetry = codexTelemetryDescriptor(requestedModel)
    const responder: DialogueResponder = async (input, signal) => {
        let observation: RunnerInvocationObservation | undefined
        try {
            const text = await runCodexOneShot({
                prompt: `${input.systemPrompt}\n\n${input.userPrompt}`,
                cwd: opts.cwd,
                model: opts.model,
                codexBin: opts.codexBin,
                timeoutMs: opts.timeoutMs ?? 60_000,
                label: "codex-dialogue",
                // Conversation is an intent/status surface. It has no reason
                // to mutate the checkout or retain a separate Codex thread.
                bypassSandbox: false,
                sandboxMode: "read-only",
                ephemeral: true,
                skipGitRepoCheck: opts.codexSkipGitRepoCheck,
                signal,
                onInvocation: (item) => {
                    observation = item
                },
            })
            return {
                text,
                invocation: codexInvocation(
                    requestedModel,
                    observation ?? unknownCodexObservation(
                        "succeeded",
                        "not_reported",
                        requestedModel,
                    ),
                ),
            }
        } catch (error) {
            if (!observation && isProcessLaunchFailure(error)) {
                throw new Error("Codex dialogue process could not start")
            }
            const timedOut = isTimeout(error)
            throw new DialogueResponderInvocationError(
                "Codex dialogue provider failed",
                observation
                    ? codexInvocation(requestedModel, observation)
                    : telemetry.failureInvocation(
                          timedOut ? "timed_out" : "failed",
                          timedOut ? "timed_out" : "not_reported",
                      ),
            )
        }
    }
    return Object.assign(responder, { telemetry })
}

function createClaudeResponder(
    opts: CreateDialogueResponderOptions,
): DialogueResponder {
    const requestedModel = opts.model ?? "haiku"
    const telemetry = claudeTelemetryDescriptor(requestedModel)
    const responder: DialogueResponder = async (input, signal) => {
        let stdout: string
        try {
            stdout = await execClaude(
                opts.claudeBin ?? "claude",
                [
                    "--print",
                    "--output-format",
                    "json",
                    "--model",
                    requestedModel,
                    // Dialogue is communication-only. An empty tool allow-list
                    // prevents the backing CLI from editing or shelling out.
                    "--tools",
                    "",
                    "--system-prompt",
                    input.systemPrompt,
                    "-p",
                    input.userPrompt,
                ],
                {
                    cwd: opts.cwd,
                    timeoutMs: opts.timeoutMs ?? 60_000,
                    signal,
                },
            )
        } catch (error) {
            // A missing/non-executable harness never reached a model provider,
            // so it must not be counted as an invocation.
            if (isProcessLaunchFailure(error)) {
                throw new Error("Claude dialogue process could not start")
            }
            const timedOut = isTimeout(error)
            throw new DialogueResponderInvocationError(
                "Claude dialogue provider failed",
                telemetry.failureInvocation(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }

        let wrapper: Record<string, unknown>
        try {
            const value: unknown = JSON.parse(stdout)
            if (!isRecord(value)) throw new Error("wrapper is not an object")
            wrapper = value
        } catch {
            throw new DialogueResponderInvocationError(
                "Claude dialogue returned malformed JSON",
                claudeInvocation(
                    requestedModel,
                    succeededUnknownObservation("parse_error", "claude"),
                ),
            )
        }

        const invocation = claudeInvocation(
            requestedModel,
            claudeObservation(wrapper, requestedModel),
        )
        if (typeof wrapper.result !== "string" || !wrapper.result.trim()) {
            throw new DialogueResponderInvocationError(
                "Claude dialogue returned no text",
                invocation,
            )
        }
        return { text: wrapper.result, invocation }
    }
    return Object.assign(responder, { telemetry })
}

function createOpenAIResponder(
    opts: CreateDialogueResponderOptions,
): DialogueResponder {
    const requestedModel = opts.model ?? "gpt-5.4-mini"
    const model = new GenericOpenAIModel(
        requestedModel,
        opts.openaiConnection,
    )
    model.setTools([])
    const genericEndpoint = Boolean(opts.openaiConnection?.baseURL)
    const billingEnabled = Boolean(
        opts.billingCoordinator?.trustsEndpoint(
            opts.openaiConnection?.baseURL ?? process.env.OPENAI_BASE_URL,
            opts.openaiConnection?.apiKey ?? process.env.OPENAI_API_KEY,
        ),
    )
    const telemetry = openAITelemetryDescriptor(
        requestedModel,
        billingEnabled,
    )
    const responder: DialogueResponder = async (input, signal) => {
        if (signal.aborted) throw abortError()
        const context = ModelContext.create(`dialogue:${input.messageId}`)
            .addContextItem(SystemMessageItem.create(input.systemPrompt))
            .addContextItem(UserMessageItem.create(input.userPrompt))
        let round: Awaited<ReturnType<typeof runInferenceRound>>
        try {
            round = await abortable(
                (opts.openaiRunRound ?? runInferenceRound)(
                    context,
                    model,
                    billingEnabled && opts.billingCoordinator
                        ? {
                              billing: {
                                  coordinator: opts.billingCoordinator,
                                  context: {
                                      runId: input.runId,
                                      phase: "dialogue",
                                      storyId: null,
                                      leaseId: null,
                                      generation: null,
                                      attempt: null,
                                      turn: 1,
                                      round: 1,
                                  },
                              },
                          }
                        : {},
                ),
                signal,
            )
        } catch (error) {
            const timedOut = isTimeout(error)
            throw new DialogueResponderInvocationError(
                "OpenAI dialogue provider failed",
                telemetry.failureInvocation(
                    timedOut ? "timed_out" : "failed",
                    timedOut ? "timed_out" : "not_reported",
                ),
            )
        }
        const invocation = openAIInvocation(
            requestedModel,
            openAIObservation(round.usage, requestedModel, genericEndpoint),
            round.billingInvocationId !== null,
        )
        let text = ""
        for (const item of round.items) {
            if (item.type !== "message") continue
            const json = item.toJSON() as {
                content?: Array<{ text?: unknown }>
            }
            for (const content of json.content ?? []) {
                if (typeof content.text === "string") text += content.text
            }
        }
        if (!text.trim()) {
            throw new DialogueResponderInvocationError(
                "OpenAI dialogue returned no text",
                invocation,
            )
        }
        return { text, invocation }
    }
    return Object.assign(responder, { telemetry })
}

function claudeTelemetryDescriptor(
    requestedModel: string,
): DialogueResponderTelemetry {
    return Object.freeze({
        failureInvocation(
            status: Extract<ModelInvocationStatus, "failed" | "timed_out">,
            reason: UnknownMetricReason,
        ): DialogueResponderInvocation {
            return claudeInvocation(
                requestedModel,
                unknownObservation(status, reason, "claude"),
            )
        },
    })
}

function openAITelemetryDescriptor(
    requestedModel: string,
    measurementPublished = false,
): DialogueResponderTelemetry {
    return Object.freeze({
        failureInvocation(
            status: Extract<ModelInvocationStatus, "failed" | "timed_out">,
            reason: UnknownMetricReason,
        ): DialogueResponderInvocation {
            return openAIInvocation(
                requestedModel,
                unknownObservation(status, reason, "openai"),
                measurementPublished,
            )
        },
    })
}

function codexTelemetryDescriptor(
    requestedModel: string,
): DialogueResponderTelemetry {
    return Object.freeze({
        failureInvocation(
            status: Extract<ModelInvocationStatus, "failed" | "timed_out">,
            reason: UnknownMetricReason,
        ): DialogueResponderInvocation {
            return codexInvocation(
                requestedModel,
                unknownCodexObservation(status, reason, requestedModel),
            )
        },
    })
}

function localHarnessTelemetryDescriptor(
    backend: "opencode" | "pi",
    requestedModel: string,
): DialogueResponderTelemetry {
    return Object.freeze({
        failureInvocation(
            status: Extract<ModelInvocationStatus, "failed" | "timed_out">,
            reason: UnknownMetricReason,
        ): DialogueResponderInvocation {
            return localHarnessInvocation(
                backend,
                requestedModel,
                unknownLocalHarnessObservation(
                    status,
                    reason,
                    backend,
                    requestedModel,
                ),
            )
        },
    })
}

function claudeInvocation(
    requestedModel: string,
    observation: RunnerInvocationObservation,
): DialogueResponderInvocation {
    return { backend: "claude", requestedModel, observation }
}

function openAIInvocation(
    requestedModel: string,
    observation: RunnerInvocationObservation,
    measurementPublished = false,
): DialogueResponderInvocation {
    return {
        backend: "openai",
        requestedModel,
        observation,
        ...(measurementPublished ? { measurementPublished: true } : {}),
    }
}

function codexInvocation(
    requestedModel: string,
    observation: RunnerInvocationObservation,
): DialogueResponderInvocation {
    return { backend: "codex", requestedModel, observation }
}

function localHarnessInvocation(
    backend: "opencode" | "pi",
    requestedModel: string,
    observation: RunnerInvocationObservation,
): DialogueResponderInvocation {
    return { backend, requestedModel, observation }
}

function unknownLocalHarnessObservation(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
    backend: "opencode" | "pi",
    requestedModel: string,
): RunnerInvocationObservation {
    const missing = unknownMetric(reason)
    const defaultModel = requestedModel === `${backend}-default`
    const slash = backend === "opencode" ? requestedModel.indexOf("/") : -1
    return {
        sequence: 1,
        granularity: backend === "opencode" ? "round" : "turn",
        status,
        durationMs: missing,
        tokens: {
            inputTotal: missing,
            cachedInput: missing,
            cacheWriteInput: missing,
            outputTotal: missing,
            reasoningOutput:
                backend === "pi" ? notApplicableMetric() : missing,
            total: missing,
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: missing,
        },
        provider:
            slash > 0 ? requestedModel.slice(0, slash) : null,
        resolvedModel: defaultModel
            ? null
            : slash > 0
              ? requestedModel.slice(slash + 1) || null
              : requestedModel,
        providerRequestId: null,
    }
}

function unknownCodexObservation(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
    requestedModel: string,
): RunnerInvocationObservation {
    const missing = unknownMetric(reason)
    return {
        sequence: 1,
        granularity: "turn",
        status,
        durationMs: missing,
        tokens: {
            inputTotal: missing,
            cachedInput: missing,
            cacheWriteInput: notApplicableMetric(),
            outputTotal: missing,
            reasoningOutput: missing,
            total: missing,
        },
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: missing,
        },
        provider: "openai",
        resolvedModel: requestedModel === "codex-default" ? null : requestedModel,
        providerRequestId: null,
    }
}

function claudeObservation(
    wrapper: Record<string, unknown>,
    requestedModel: string,
): RunnerInvocationObservation {
    const usage = isRecord(wrapper.usage) ? wrapper.usage : null
    return {
        sequence: 1,
        granularity: "process",
        status: "succeeded",
        durationMs: metricFromKeys(wrapper, ["duration_ms"], "cli_result"),
        tokens: usage
            ? claudeTokens(usage)
            : unknownClaudeTokens(
                  wrapper.usage == null ? "not_reported" : "parse_error",
              ),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: metricFromKeys(
                wrapper,
                ["total_cost_usd"],
                "cli_result",
            ),
        },
        // Claude CLI can be configured for Anthropic, Bedrock, or Vertex.
        provider: null,
        resolvedModel: requestedModel,
        // `session_id` is resumable harness state, not an upstream charge id.
        providerRequestId: null,
    }
}

function openAIObservation(
    usage: TokenUsage | undefined,
    requestedModel: string,
    genericEndpoint: boolean,
): RunnerInvocationObservation {
    return {
        sequence: 1,
        granularity: "round",
        status: "succeeded",
        durationMs: unknownMetric("not_reported"),
        tokens: usage
            ? openAITokens(usage, genericEndpoint)
            : unknownOpenAITokens("not_reported"),
        cost: pendingOpenAICost(),
        // An OpenAI-compatible endpoint is not necessarily OpenAI itself.
        provider: null,
        resolvedModel: requestedModel,
        providerRequestId: null,
    }
}

function succeededUnknownObservation(
    reason: UnknownMetricReason,
    backend: "claude" | "openai",
): RunnerInvocationObservation {
    return unknownObservation("succeeded", reason, backend)
}

function unknownObservation(
    status: ModelInvocationStatus,
    reason: UnknownMetricReason,
    backend: "claude" | "openai",
): RunnerInvocationObservation {
    return {
        sequence: 1,
        granularity: backend === "claude" ? "process" : "round",
        status,
        durationMs: unknownMetric(reason),
        tokens: backend === "claude"
            ? unknownClaudeTokens(reason)
            : unknownOpenAITokens(reason),
        cost: backend === "claude"
            ? {
                  providerUsd: notApplicableMetric(),
                  customerUsd: notApplicableMetric(),
                  equivalentUsd: unknownMetric(reason),
              }
            : pendingOpenAICost(),
        provider: null,
        resolvedModel: null,
        providerRequestId: null,
    }
}

function claudeTokens(usage: Record<string, unknown>): ModelTokenMetrics {
    const cache = isRecord(usage.cache) ? usage.cache : null
    const rawInput = metricFromKeys(
        usage,
        ["input_tokens", "inputTokens"],
        "provider_response",
    )
    const cachedInput = firstReportedMetric([
        metricFromKeysOptional(
            usage,
            ["cache_read_input_tokens", "cached_input_tokens"],
            "provider_response",
        ),
        cache
            ? metricFromKeysOptional(cache, ["read"], "provider_response")
            : null,
    ])
    const cacheWriteInput = firstReportedMetric([
        metricFromKeysOptional(
            usage,
            ["cache_creation_input_tokens", "cache_write_input_tokens"],
            "provider_response",
        ),
        cache
            ? metricFromKeysOptional(cache, ["write"], "provider_response")
            : null,
    ])
    const outputTotal = metricFromKeys(
        usage,
        ["output_tokens", "outputTokens"],
        "provider_response",
    )
    const inputTotal = sumMetrics([rawInput, cachedInput, cacheWriteInput])
    const reportedTotal = metricFromKeysOptional(
        usage,
        ["total_tokens", "totalTokens"],
        "provider_response",
    )
    return {
        inputTotal,
        cachedInput,
        cacheWriteInput,
        outputTotal,
        reasoningOutput: notApplicableMetric(),
        total: reportedTotal ?? sumMetrics([inputTotal, outputTotal]),
    }
}

function openAITokens(
    usage: TokenUsage,
    genericEndpoint: boolean,
): ModelTokenMetrics {
    const cached = usage.inputTokenDetails?.cached_tokens
    return {
        inputTotal: tokenMetric(usage.inputTokens),
        // Some compatible gateways synthesize cached_tokens=0 when the
        // upstream omitted cache details. Preserve positive evidence, but do
        // not turn that ambiguous generic-endpoint zero into a known value.
        cachedInput:
            genericEndpoint && cached === 0
                ? unknownMetric("not_reported")
                : tokenMetric(cached),
        cacheWriteInput: notApplicableMetric(),
        outputTotal: tokenMetric(usage.outputTokens),
        reasoningOutput: tokenMetric(
            usage.outputTokenDetails?.reasoning_tokens,
        ),
        total: tokenMetric(usage.totalTokens),
    }
}

function unknownClaudeTokens(reason: UnknownMetricReason): ModelTokenMetrics {
    return {
        inputTotal: unknownMetric(reason),
        cachedInput: unknownMetric(reason),
        cacheWriteInput: unknownMetric(reason),
        outputTotal: unknownMetric(reason),
        reasoningOutput: notApplicableMetric(),
        total: unknownMetric(reason),
    }
}

function unknownOpenAITokens(reason: UnknownMetricReason): ModelTokenMetrics {
    return {
        inputTotal: unknownMetric(reason),
        cachedInput: unknownMetric(reason),
        cacheWriteInput: notApplicableMetric(),
        outputTotal: unknownMetric(reason),
        reasoningOutput: unknownMetric(reason),
        total: unknownMetric(reason),
    }
}

function pendingOpenAICost(): ModelCostMetrics {
    return {
        providerUsd: unknownMetric("pending_gateway_meter"),
        customerUsd: unknownMetric("pending_gateway_meter"),
        equivalentUsd: notApplicableMetric(),
    }
}

function tokenMetric(value: unknown): Metric {
    return value == null
        ? unknownMetric("not_reported")
        : typeof value === "number" && Number.isFinite(value) && value >= 0
          ? knownMetric(value, "provider_response")
          : unknownMetric("parse_error")
}

function metricFromKeys(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric {
    return metricFromKeysOptional(source, keys, metricSource)
        ?? unknownMetric("not_reported")
}

function metricFromKeysOptional(
    source: Record<string, unknown>,
    keys: readonly string[],
    metricSource: MetricSource,
): Metric | null {
    for (const key of keys) {
        if (!(key in source) || source[key] == null) continue
        const value = source[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0
            ? knownMetric(value, metricSource)
            : unknownMetric("parse_error")
    }
    return null
}

function firstReportedMetric(metrics: readonly (Metric | null)[]): Metric {
    return metrics.find((metric): metric is Metric => metric !== null)
        ?? unknownMetric("not_reported")
}

function sumMetrics(metrics: readonly Metric[]): Metric {
    if (metrics.every((metric) => metric.state === "known")) {
        return knownMetric(
            metrics.reduce(
                (sum, metric) =>
                    sum + (metric.state === "known" ? metric.value : 0),
                0,
            ),
            "derived",
        )
    }
    const missing = metrics.find((metric) => metric.state === "unknown")
    return missing?.state === "unknown"
        ? unknownMetric(missing.reason)
        : unknownMetric("not_reported")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isTimeout(error: unknown): boolean {
    if (!isRecord(error)) return false
    if (error.name === "AbortError" || error.code === "ETIMEDOUT") return true
    if (error.killed === true) return true
    return typeof error.message === "string"
        && /(?:timed?\s*out|timeout)/i.test(error.message)
}

function isProcessLaunchFailure(error: unknown): boolean {
    if (!isRecord(error)) return false
    return error.code === "ENOENT"
        || error.code === "EACCES"
        || error.code === "ENOTDIR"
}

interface ExecClaudeOptions {
    cwd: string
    timeoutMs: number
    signal: AbortSignal
}

function execClaude(
    binary: string,
    args: readonly string[],
    opts: ExecClaudeOptions,
): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            binary,
            [...args],
            {
                cwd: opts.cwd,
                env: harnessChildEnvironment(),
                timeout: opts.timeoutMs,
                maxBuffer: 4 * 1024 * 1024,
                signal: opts.signal,
            },
            (error, stdout) => {
                if (error) reject(error)
                else resolve(stdout)
            },
        )
    })
}

async function withIsolatedHarnessCwd<T>(
    prefix: string,
    run: (cwd: string) => Promise<T>,
): Promise<T> {
    // Each invocation gets a repository-independent directory. Besides
    // excluding project instructions/config/context, this lets OpenCode's
    // deny-all config use fail-closed `wx` creation on every dialogue turn.
    const cwd = await mkdtemp(join(tmpdir(), prefix))
    try {
        return await run(cwd)
    } finally {
        await rm(cwd, { recursive: true, force: true })
    }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortError())
        signal.addEventListener("abort", onAbort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener("abort", onAbort)
                reject(error)
            },
        )
    })
}

function abortError(): Error {
    const error = new Error("dialogue response aborted")
    error.name = "AbortError"
    return error
}
