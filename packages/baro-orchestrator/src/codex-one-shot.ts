/**
 * One-shot `codex exec --json` against a combined prompt; returns the
 * concatenated `agent_message` text. Uses spawn() + streaming rather than
 * execFile() because execFile discards stdout on timeout — long Codex runs
 * often hit the wall-clock cap, and streaming keeps the live stderr audit
 * trail of what Codex did with those minutes, plus a gentler SIGTERM.
 */

import { ChildProcess } from "child_process"
import spawn from "cross-spawn"

import { harnessChildEnvironment } from "./harness-environment.js"
import { ManagedProcessTree } from "./process-tree.js"

import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type ModelInvocationStatus,
    type ModelTokenMetrics,
} from "./model-telemetry.js"
import {
    RunnerInvocationTracker,
    type RunnerInvocationObserver,
    type UnsequencedRunnerInvocationObservation,
} from "./runner-invocation.js"

export interface RunCodexOneShotOptions {
    /** Combined system+user prompt. */
    prompt: string
    /** Pipe the prompt over stdin with a `-` positional marker. */
    promptViaStdin?: boolean
    /** Working directory. Must be a git repo (Codex enforces) unless
     *  skipGitRepoCheck=true. */
    cwd: string
    /** Model identifier. Defaults to Codex's own pick (gpt-5.5 on Plus+). */
    model?: string
    /** Explicit Codex reasoning effort; useful when user config is isolated. */
    reasoningEffort?:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max"
        | "ultra"
    /** Bypass Codex's sandbox + approval prompts. Default: true. */
    bypassSandbox?: boolean
    /** Sandbox used when bypassSandbox=false. Conversation/intake calls use
     * read-only so a model classifying intent cannot mutate the checkout. */
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access"
    /** Use a Codex permission profile that grants spawned tools only minimal
     * runtime reads, denies the workspace, and disables tool network access. */
    isolateToolFilesystem?: boolean
    /** Do not persist a Codex harness thread for this isolated call. */
    ephemeral?: boolean
    /** Ignore user config while retaining CODEX_HOME authentication. */
    ignoreUserConfig?: boolean
    /** Ignore user/project exec-policy rules for this isolated call. */
    ignoreRules?: boolean
    /** Disable user/project/plugin hooks for this isolated call. */
    disableHooks?: boolean
    /** Never ask interactively; denied actions fail instead. */
    neverApprove?: boolean
    /** Keep planner exploration repository-local. */
    disableWebSearch?: boolean
    /** Mark this canonical checkout path untrusted so project `.codex/`
     * configuration, hooks, and rules are not loaded. */
    untrustedProjectPath?: string
    /** Extra variables for the Codex process itself. Secret values used by an
     * MCP child belong here and must be referenced by name through envVars so
     * they never appear in Codex argv. */
    additionalEnvironment?: Readonly<Record<string, string>>
    /** Disable automatic AGENTS.md/project-document prompt injection. The
     * CLI is run with strict config so an older Codex fails closed instead of
     * silently losing this trust boundary. */
    disableProjectDocs?: boolean
    /** Native final-response JSON Schema file, owned by the caller. */
    outputSchemaFile?: string
    /** Exact run-scoped STDIO MCP surface. Callers that need to exclude
     * ambient user servers must also set ignoreUserConfig=true. */
    mcpServer?: {
        name: string
        command: string
        args: readonly string[]
        /** Names inherited from the Codex process by this MCP child. */
        envVars?: readonly string[]
        enabledTools: readonly string[]
    }
    /** Skip the "must be inside a git repo" check. Default: false. */
    skipGitRepoCheck?: boolean
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /** Grace after SIGTERM before SIGKILL. Default: 5_000ms; injectable for tests. */
    terminationGraceMs?: number
    /** Per-phase prefix for the live stderr stream. Default: "codex". */
    label?: string
    /** Optional invocation telemetry sink. It cannot alter runner success. */
    onInvocation?: RunnerInvocationObserver
    /** Caller cancellation. The child is terminated and partial output is
     * rejected exactly like a timeout or crash. */
    signal?: AbortSignal
}

export async function runCodexOneShot(
    opts: RunCodexOneShotOptions,
): Promise<string> {
    if (opts.signal?.aborted) {
        throw new Error("runCodexOneShot: aborted before launch")
    }
    if (
        opts.reasoningEffort !== undefined &&
        !CODEX_REASONING_EFFORTS.has(opts.reasoningEffort)
    ) {
        throw new TypeError(
            `runCodexOneShot: unsupported reasoning effort ${JSON.stringify(opts.reasoningEffort)}`,
        )
    }
    const additionalEnvironment = validateAdditionalEnvironment(
        opts.additionalEnvironment,
    )
    const label = opts.label ?? "codex"
    const args = ["exec", "--json"]
    if (opts.skipGitRepoCheck) args.push("--skip-git-repo-check")
    if (opts.isolateToolFilesystem && opts.bypassSandbox !== false) {
        throw new TypeError(
            "runCodexOneShot: isolateToolFilesystem requires bypassSandbox=false",
        )
    }
    if (opts.isolateToolFilesystem && opts.sandboxMode) {
        throw new TypeError(
            "runCodexOneShot: permission profiles cannot be combined with sandboxMode",
        )
    }
    if (opts.bypassSandbox !== false) {
        args.push("--dangerously-bypass-approvals-and-sandbox")
    } else if (opts.isolateToolFilesystem) {
        args.push(
            "--strict-config",
            "--config",
            'default_permissions="baro_dialogue"',
            "--config",
            'permissions.baro_dialogue.description="Baro brokered text-only front door"',
            "--config",
            'permissions.baro_dialogue.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
            "--config",
            'approval_policy="never"',
            "--config",
            'web_search="disabled"',
            "--config",
            'shell_environment_policy.inherit="none"',
            "--config",
            "allow_login_shell=false",
        )
    } else if (opts.sandboxMode) {
        args.push("--sandbox", opts.sandboxMode)
    }
    if (opts.ephemeral) args.push("--ephemeral")
    if (opts.ignoreUserConfig) args.push("--ignore-user-config")
    if (opts.ignoreRules) args.push("--ignore-rules")
    if (opts.disableHooks) args.push("--disable", "hooks")
    if (opts.neverApprove) {
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push("--config", 'approval_policy="never"')
    }
    if (opts.disableWebSearch) {
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push("--config", 'web_search="disabled"')
    }
    if (opts.untrustedProjectPath) {
        if (!safeMcpText(opts.untrustedProjectPath)) {
            throw new TypeError(
                "runCodexOneShot: untrustedProjectPath must be safe non-empty text",
            )
        }
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push(
            "--config",
            // Codex's CLI override path parser splits dotted keys before it
            // interprets quoted segments. A checkout path such as
            // `Miodrag.todorovic.ext/...` therefore cannot safely appear in a
            // dotted override. Send the complete map as one TOML value.
            `projects={${tomlString(opts.untrustedProjectPath)}={trust_level="untrusted"}}`,
        )
    }
    if (opts.disableProjectDocs) {
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push("--config", "project_doc_max_bytes=0")
    }
    if (opts.mcpServer) {
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push(
            "--config",
            codexMcpServersOverride(opts.mcpServer),
        )
        if (opts.mcpServer.envVars?.length) {
            args.push(
                "--config",
                `shell_environment_policy.exclude=${tomlEnvironmentNames(opts.mcpServer.envVars)}`,
            )
        }
    }
    if (opts.outputSchemaFile) args.push("--output-schema", opts.outputSchemaFile)
    if (opts.reasoningEffort) {
        if (!args.includes("--strict-config")) args.push("--strict-config")
        args.push(
            "--config",
            `model_reasoning_effort=${tomlString(opts.reasoningEffort)}`,
        )
    }
    if (opts.model) args.push("--model", opts.model)
    args.push(opts.promptViaStdin ? "-" : opts.prompt)

    const timeoutMs = opts.timeoutMs ?? 600_000
    const terminationGraceMs = opts.terminationGraceMs ?? 5_000
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 1) {
        throw new RangeError("runCodexOneShot: terminationGraceMs must be positive")
    }

    return await new Promise<string>((resolve, reject) => {
        const startedAt = Date.now()
        const invocations = new RunnerInvocationTracker(opts.onInvocation)
        let proc: ChildProcess
        try {
            proc = spawn(opts.codexBin ?? "codex", args, {
                cwd: opts.cwd,
                env: {
                    ...harnessChildEnvironment(),
                    ...additionalEnvironment,
                },
                stdio: [opts.promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
            })
        } catch (e) {
            invocations.finish(
                unknownCodexObservation("failed", Date.now() - startedAt, opts),
            )
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }
        const processTree = new ManagedProcessTree(proc, {
            terminationGraceMs,
            pollIntervalMs: 25,
        })

        let agentMessage = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        const itemTypesSeen: string[] = []
        let timedOut = false
        let aborted = false
        let stdinError: Error | null = null
        let processError: Error | null = null
        let finalized = false
        let treeRefreshed = false
        let rootExit: {
            code: number | null
            signal: NodeJS.Signals | null
        } | null = null

        const cleanup = (): void => {
            clearTimeout(timer)
            opts.signal?.removeEventListener("abort", onAbort)
        }
        const refreshProcessTree = (): void => {
            if (treeRefreshed) return
            treeRefreshed = true
            processTree.refresh()
        }
        const finalizeExit = (
            code: number | null,
            signal: NodeJS.Signals | null,
        ): void => {
            if (finalized) return
            finalized = true
            cleanup()
            const elapsedMs = Date.now() - startedAt

            const ctx = [
                `elapsed=${elapsedMs}ms`,
                `exit=${code}`,
                signal ? `signal=${signal}` : null,
                timedOut ? `timedOut=true (cap=${timeoutMs}ms)` : null,
                aborted ? "aborted=true" : null,
                `events=${eventTypesSeen.length}`,
                `items=${itemTypesSeen.length}`,
                eventTypesSeen.length > 0
                    ? `event_types=[${[...new Set(eventTypesSeen)].join(",")}]`
                    : null,
                itemTypesSeen.length > 0
                    ? `item_types=[${[...new Set(itemTypesSeen)].join(",")}]`
                    : null,
            ]
                .filter((x): x is string => x !== null)
                .join(" ")

            // Abnormal termination must fail even if SOME text accumulated:
            // callers feed the string into a markdown/JSON extractor that
            // accepts truncated-but-closed fragments, so partial text on
            // timeout/crash would silently yield an incomplete doc or PRD.
            if (
                processError ||
                stdinError ||
                timedOut ||
                aborted ||
                signal != null ||
                (code != null && code !== 0)
            ) {
                if (
                    !invocations.finish(
                        unknownCodexObservation(
                            timedOut ? "timed_out" : "failed",
                            elapsedMs,
                            opts,
                        ),
                    )
                ) {
                    return
                }
                reject(
                    processError ?? stdinError ?? new Error(
                        `runCodexOneShot: codex terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (agentMessage.trim()) {
                if (
                    !invocations.finish(
                        unknownCodexObservation(
                            "succeeded",
                            elapsedMs,
                            opts,
                        ),
                    )
                ) {
                    return
                }
                resolve(agentMessage)
                return
            }

            if (
                !invocations.finish(
                    unknownCodexObservation("failed", elapsedMs, opts),
                )
            ) {
                return
            }
            reject(
                new Error(
                    `runCodexOneShot: codex produced no agent_message (${ctx})`,
                ),
            )
        }
        const finalizeAbnormalAfterTree = (): void => {
            void processTree.done.then(() => {
                // An unobserved descendant can retain the inherited pipe even
                // after ManagedProcessTree has exhausted what it can discover.
                // Abnormal completion is already discarding partial output, so
                // release our local handles instead of waiting forever on close.
                proc.stdin?.destroy()
                proc.stdout?.destroy()
                proc.stderr?.destroy()
                const terminal = rootExit ?? { code: null, signal: null }
                finalizeExit(terminal.code, terminal.signal)
            })
        }
        const terminate = (): void => {
            processTree.terminate("SIGTERM")
            finalizeAbnormalAfterTree()
        }
        const onAbort = (): void => {
            if (aborted) return
            aborted = true
            terminate()
        }

        const timer = setTimeout(() => {
            if (timedOut) return
            timedOut = true
            terminate()
        }, timeoutMs)
        timer.unref?.()
        opts.signal?.addEventListener("abort", onAbort, { once: true })
        // Close the race between the pre-spawn check and listener install.
        if (opts.signal?.aborted) onAbort()

        const processLine = (rawLine: string): void => {
            const line = rawLine.trim()
            if (!line) return
            let event: Record<string, unknown>
            try {
                event = JSON.parse(line) as Record<string, unknown>
            } catch {
                return
            }
            const type = typeof event.type === "string" ? event.type : ""
            if (type) eventTypesSeen.push(type)

            if (type === "turn.completed") {
                const usage = record(event.usage)
                if (Object.keys(usage).length > 0) {
                    process.stderr.write(
                        `[${label}] usage: in=${numberForLog(usage.input_tokens)} out=${numberForLog(usage.output_tokens)}\n`,
                    )
                }
                // A thread id identifies the Codex harness session, not
                // an upstream model request, so it must never populate
                // providerRequestId.
                if (!timedOut) {
                    invocations.observe(
                        codexObservation(
                            event,
                            Date.now() - startedAt,
                            opts,
                        ),
                    )
                }
                return
            }
            if (type === "item.completed") {
                const item = event.item as Record<string, unknown> | undefined
                if (!item) return
                const innerType =
                    typeof item.type === "string" ? item.type : "?"
                itemTypesSeen.push(innerType)
                if (
                    item.type === "agent_message" &&
                    typeof item.text === "string"
                ) {
                    // Codex can emit completed assistant/status messages before
                    // the terminal response. Keep only the terminal message.
                    agentMessage = item.text
                } else if (innerType === "command_execution") {
                    const cmd =
                        typeof item.command === "string"
                            ? item.command.slice(0, 120)
                            : "?"
                    process.stderr.write(`[${label}] $ ${cmd}\n`)
                }
            }
        }

        proc.stdout!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => {
            refreshProcessTree()
            stdoutBuffer += chunk
            let nl: number
            while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
                const line = stdoutBuffer.slice(0, nl)
                stdoutBuffer = stdoutBuffer.slice(nl + 1)
                processLine(line)
            }
        })
        proc.stdout!.on("end", () => {
            if (stdoutBuffer.length === 0) return
            processLine(stdoutBuffer)
            stdoutBuffer = ""
        })

        proc.stderr!.setEncoding("utf8")
        proc.stderr!.on("data", (chunk: string) => {
            refreshProcessTree()
            const trimmed = chunk.trimEnd()
            if (trimmed) {
                process.stderr.write(`[${label}/stderr] ${trimmed}\n`)
            }
        })

        proc.on("error", (err) => {
            processError ??= err
            if (proc.pid === undefined) processTree.markRootClosed()
            else processTree.terminate("SIGTERM")
            finalizeAbnormalAfterTree()
        })

        proc.on("exit", (code, signal) => {
            rootExit = { code, signal }
            processTree.markRootClosed()
        })
        proc.on("close", (code, signal) => {
            rootExit ??= { code, signal }
            processTree.markRootClosed()
            const terminal = rootExit
            void processTree.done.then(() =>
                finalizeExit(terminal.code, terminal.signal),
            )
        })
        if (opts.promptViaStdin) {
            if (!proc.stdin) {
                stdinError = new Error("runCodexOneShot: codex stdin is unavailable")
                terminate()
            } else {
                proc.stdin.on("error", (error) => {
                    stdinError = error
                    terminate()
                })
                proc.stdin.end(opts.prompt)
            }
        }
    })
}

const CODEX_REASONING_EFFORTS = new Set<string>([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
])

function codexMcpServersOverride(
    server: NonNullable<RunCodexOneShotOptions["mcpServer"]>,
): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(server.name)) {
        throw new TypeError("runCodexOneShot: MCP server name is not a safe TOML key")
    }
    if (!safeMcpText(server.command)) {
        throw new TypeError("runCodexOneShot: MCP command must be safe non-empty text")
    }
    if (
        !Array.isArray(server.args) ||
        server.args.some((value) => !safeMcpText(value))
    ) {
        throw new TypeError("runCodexOneShot: MCP args must be safe non-empty text")
    }
    if (
        !Array.isArray(server.enabledTools) ||
        server.enabledTools.length === 0 ||
        server.enabledTools.some((value) => !/^[A-Za-z0-9_.:-]+$/u.test(value))
    ) {
        throw new TypeError("runCodexOneShot: MCP enabledTools are invalid")
    }
    const command = tomlString(server.command)
    const childArgs = tomlStringArray(server.args)
    const enabledTools = tomlStringArray(server.enabledTools)
    const environmentNames = tomlEnvironmentNames(server.envVars ?? [])
    const toolApprovals = tomlToolApprovals(server.enabledTools)
    return (
        `mcp_servers={` +
        `${server.name}={` +
        `command=${command},` +
        `args=${childArgs},` +
        `env_vars=${environmentNames},` +
        `required=true,` +
        `enabled=true,` +
        `enabled_tools=${enabledTools},` +
        `default_tools_approval_mode="prompt",` +
        `tools=${toolApprovals},` +
        `startup_timeout_sec=15.0,` +
        `tool_timeout_sec=120.0` +
        `}}`
    )
}

function safeMcpText(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 64 * 1024 &&
        !/[\u0000\r\n]/u.test(value)
    )
}

function tomlString(value: string): string {
    // JSON basic strings are a strict subset of TOML basic strings for the
    // path/argument text admitted above, including escaped Windows slashes.
    return JSON.stringify(value)
}

function tomlStringArray(values: readonly string[]): string {
    return `[${values.map(tomlString).join(",")}]`
}

function tomlEnvironmentNames(values: readonly string[]): string {
    if (
        !Array.isArray(values) ||
        new Set(values).size !== values.length ||
        values.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    ) {
        throw new TypeError("runCodexOneShot: MCP environment names are invalid")
    }
    return tomlStringArray([...values].sort((left, right) => left.localeCompare(right)))
}

function validateAdditionalEnvironment(
    values: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
    if (!values) return {}
    const entries = Object.entries(values)
    if (
        entries.some(
            ([key, value]) =>
                !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !safeMcpText(value),
        )
    ) {
        throw new TypeError("runCodexOneShot: additional environment is invalid")
    }
    return Object.fromEntries(entries)
}

function tomlToolApprovals(tools: readonly string[]): string {
    return `{${[...tools]
        .sort((left, right) => left.localeCompare(right))
        .map((tool) => `${tomlString(tool)}={approval_mode="approve"}`)
        .join(",")}}`
}

function codexObservation(
    event: Record<string, unknown>,
    elapsedMs: number,
    opts: RunCodexOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const usage = record(event.usage)
    return {
        granularity: "turn",
        status: "succeeded",
        durationMs: knownMetric(elapsedMs, "cli_result"),
        tokens: codexTokenMetrics(usage),
        cost: {
            providerUsd: notApplicableMetric(),
            customerUsd: notApplicableMetric(),
            equivalentUsd: unknownMetric("not_reported"),
        },
        provider: "openai",
        resolvedModel: nonEmptyString(event.model) ?? opts.model ?? null,
        providerRequestId: null,
    }
}

function unknownCodexObservation(
    status: ModelInvocationStatus,
    elapsedMs: number,
    opts: RunCodexOneShotOptions,
): UnsequencedRunnerInvocationObservation {
    const reason = status === "timed_out" ? "timed_out" : "not_reported"
    const missing = unknownMetric(reason)
    return {
        granularity: "turn",
        status,
        durationMs: knownMetric(elapsedMs, "cli_result"),
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
        resolvedModel: opts.model ?? null,
        providerRequestId: null,
    }
}

function codexTokenMetrics(usage: Record<string, unknown>): ModelTokenMetrics {
    const input = metric(usage, "input_tokens")
    const output = metric(usage, "output_tokens")
    return {
        // Codex reports cached input as a subset of input_tokens.
        inputTotal: input,
        cachedInput: metric(usage, "cached_input_tokens"),
        cacheWriteInput: notApplicableMetric(),
        outputTotal: output,
        // Likewise reasoning_output_tokens is a subset of output_tokens.
        reasoningOutput: metric(usage, "reasoning_output_tokens"),
        total: optionalMetric(usage, "total_tokens") ?? sumKnown([input, output]),
    }
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

function metric(source: Record<string, unknown>, key: string): Metric {
    if (!(key in source) || source[key] == null) {
        return unknownMetric("not_reported")
    }
    const value = source[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? knownMetric(value, "provider_response")
        : unknownMetric("parse_error")
}

function optionalMetric(
    source: Record<string, unknown>,
    key: string,
): Metric | null {
    return key in source && source[key] != null ? metric(source, key) : null
}

function sumKnown(metrics: readonly Metric[]): Metric {
    if (metrics.every((item) => item.state === "known")) {
        return knownMetric(
            metrics.reduce(
                (sum, item) => sum + (item.state === "known" ? item.value : 0),
                0,
            ),
            "derived",
        )
    }
    const missing = metrics.find((item) => item.state === "unknown")
    return missing?.state === "unknown"
        ? unknownMetric(missing.reason)
        : unknownMetric("not_reported")
}

function numberForLog(value: unknown): number | "?" {
    return typeof value === "number" && Number.isFinite(value) ? value : "?"
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null
}
