/**
 * One `devin acp` turn against a combined prompt; returns the assistant text.
 * A safe evaluator runs Devin's tool-less "summarizer" agent, and in case a
 * release gives it tools: an empty directory whose project config denies
 * every tool, read-only "ask" mode, and any tool call fails the turn. The
 * default agent will not stay off its tools when told to (verified live).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgenticEnvironment, FunctionCallItem, ModelMessageItem } from "../../runtime/mozaik.js"
import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type ModelInvocationStatus,
} from "../../telemetry/model-telemetry.js"
import {
    RunnerInvocationTracker,
    type RunnerInvocationObserver,
    type UnsequencedRunnerInvocationObservation,
} from "../runner-invocation.js"
import { DevinCliParticipant, turnUsage, type DevinRunSummary } from "./cli-participant.js"

export interface RunDevinOneShotOptions {
    prompt: string
    cwd: string
    model?: string
    devinBin?: string
    /** Idle timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "devin". */
    label?: string
    onInvocation?: RunnerInvocationObserver
    signal?: AbortSignal
    /** Text-only evaluator: sent ahead of the prompt, with every tool denied. */
    safeEvaluatorSystemPrompt?: string
}

// Tool names and scopes from Devin's permission reference; deny always wins.
const DENY_ALL_TOOLS = {
    permissions: {
        deny: ["read", "edit", "grep", "glob", "exec", "mcp__*", "Read(**)", "Write(**)", "Exec(*)", "Fetch(*)"],
    },
}

export async function runDevinOneShot(opts: RunDevinOneShotOptions): Promise<string> {
    if (opts.signal?.aborted) throw abortError()
    const label = opts.label ?? "devin"
    const safe = opts.safeEvaluatorSystemPrompt !== undefined
    const isolatedDir = safe ? isolatedEvaluatorDir() : null
    const startedAt = Date.now()
    const invocations = new RunnerInvocationTracker(opts.onInvocation)
    let text = ""
    let toolCallSeen = false
    let timedOut = false
    let aborted = false

    const participant = new DevinCliParticipant(`${label}-one-shot`, {
        cwd: isolatedDir ?? opts.cwd,
        prompt: safe ? evaluatorPrompt(opts.safeEvaluatorSystemPrompt!, opts.prompt) : opts.prompt,
        model: opts.model,
        devinBin: opts.devinBin,
        agentType: safe ? "summarizer" : undefined,
        mode: safe ? "ask" : "bypass",
        permissions: safe ? "reject" : "allow",
        onItem: (item) => {
            if (item instanceof ModelMessageItem) {
                text = text ? `${text}\n${item.content.text}` : item.content.text
            } else if (item instanceof FunctionCallItem) {
                process.stderr.write(`[${label}] tool: ${item.name.slice(0, 120)}\n`)
                if (safe && !toolCallSeen) {
                    toolCallSeen = true
                    participant.abort()
                }
            }
        },
    })

    const timeoutMs = opts.timeoutMs ?? 600_000
    let timer: ReturnType<typeof setTimeout> | null = null
    const armIdle = (): void => {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => {
            timedOut = true
            participant.abort()
        }, timeoutMs)
        timer.unref?.()
    }
    const onAbort = (): void => {
        aborted = true
        participant.abort()
    }
    participant.onActivity = armIdle
    armIdle()
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    let summary: DevinRunSummary
    try {
        participant.start(new AgenticEnvironment(`${label}-one-shot`))
        summary = await participant.done
    } finally {
        if (timer !== null) clearTimeout(timer)
        opts.signal?.removeEventListener("abort", onAbort)
        if (isolatedDir) rmSync(isolatedDir, { recursive: true, force: true })
    }

    const elapsedMs = Date.now() - startedAt
    const fail = (status: ModelInvocationStatus, error: Error): never => {
        invocations.finish(observation(status, elapsedMs, opts, summary))
        throw error
    }
    if (aborted) fail("cancelled", abortError())
    if (timedOut) fail("timed_out", new Error(`runDevinOneShot: devin was silent for ${timeoutMs}ms`))
    if (toolCallSeen) fail("failed", new Error("runDevinOneShot: safe evaluator attempted a tool call"))
    if (summary.error) fail("failed", summary.error)
    if (summary.acpFailure) fail("failed", new Error(`runDevinOneShot: ${summary.acpFailure}`))
    if (summary.stopReason !== "end_turn") {
        fail("failed", new Error(
            `runDevinOneShot: devin did not finish its turn (stopReason=${summary.stopReason ?? "none"}, ${describeExit(summary)})`,
        ))
    }
    if (!text.trim()) fail("failed", new Error(`runDevinOneShot: devin produced no text output (${describeExit(summary)})`))
    invocations.finish(observation("succeeded", elapsedMs, opts, summary))
    return text
}

function evaluatorPrompt(system: string, prompt: string): string {
    return `${system}\n\nYou have no tools and no files: answer from the text below alone.\n\n---\n\n${prompt}`
}

function isolatedEvaluatorDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "baro-devin-eval-"))
    mkdirSync(join(dir, ".devin"))
    writeFileSync(join(dir, ".devin", "config.json"), JSON.stringify(DENY_ALL_TOOLS))
    return dir
}

function describeExit(summary: DevinRunSummary): string {
    if (summary.exitSignal) return `signal=${summary.exitSignal}`
    const tail = summary.stderrTail?.trim().split("\n").slice(-1)[0]
    return `exit=${summary.exitCode ?? "unknown"}${tail ? ` stderr=${tail.slice(0, 200)}` : ""}`
}

function observation(
    status: ModelInvocationStatus,
    elapsedMs: number,
    opts: RunDevinOneShotOptions,
    summary: DevinRunSummary | undefined,
): UnsequencedRunnerInvocationObservation {
    const usage = summary?.stopReason ? turnUsage(summary.tokens, {}) : {}
    const count = (key: string): Metric =>
        typeof usage[key] === "number" ? knownMetric(usage[key]!, "cli_result") : unknownMetric("not_reported")
    const input = count("input_tokens")
    const cached = count("cached_input_tokens")
    const output = count("output_tokens")
    const inputTotal = input.state === "known" && cached.state === "known"
        ? knownMetric(input.value + cached.value, "derived")
        : input
    return {
        granularity: "turn",
        status,
        durationMs: knownMetric(elapsedMs, "cli_result"),
        tokens: {
            inputTotal,
            cachedInput: cached,
            cacheWriteInput: unknownMetric("not_reported"),
            outputTotal: output,
            reasoningOutput: notApplicableMetric(),
            total: inputTotal.state === "known" && output.state === "known"
                ? knownMetric(inputTotal.value + output.value, "derived")
                : unknownMetric("not_reported"),
        },
        // Devin bills in credits, not dollars.
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: unknownMetric("not_reported"),
        },
        provider: "devin",
        resolvedModel: summary?.tokens?.model ?? opts.model ?? null,
        providerRequestId: summary?.sessionId ?? null,
    }
}

function abortError(): Error {
    const error = new Error("Devin one-shot aborted")
    error.name = "AbortError"
    return error
}
