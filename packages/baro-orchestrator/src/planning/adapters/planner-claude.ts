/**
 * PlannerClaude — one Planner turn via `claude --print`, optionally with a
 * live progressive-planning MCP tool during that turn.
 * Returns the raw PRD JSON string; the Rust caller deserialises it
 * (`PrdOutput`) so the schema has a single source of truth.
 */

import { execFileCli } from "../../harness/exec-file-cli.js"
import { llmIdleTimeoutMs } from "../../harness/liveness.js"
import { ClaudeStreamResultCollector } from "../../harness/claude/stream-result.js"

import { harnessChildEnvironment } from "../../harness/environment.js"

import {
    createPlannerHarnessProgressiveSupport,
    PROGRESSIVE_PLANNER_MCP_SERVER_NAME,
    type PlannerHarnessProgressiveConfig,
} from "./planner-harness-progressive.js"

import {
    PLANNER_SYSTEM_PROMPT,
    buildIntakePrompt,
    buildPlannerUserMessage,
    heuristicModeContract,
    parseModeContract,
    type ModeContract,
} from "../domain/planner-prompts.js"

export interface RunPlannerClaudeOptions {
    goal: string
    cwd: string
    model?: string
    effort?: string
    projectContext?: string
    decisionDocument?: string
    /** `--quick` hard override: exactly 1 story. */
    quick?: boolean
    /** Pre-decided contract (user pick or run-intake step); skips this planner's own intake. */
    modeContract?: ModeContract
    claudeBin?: string
    /** Collective-only early-plan tool exposed through an isolated MCP server. */
    progressive?: PlannerHarnessProgressiveConfig
    /** Explicit total wall-clock cap. Left unset, the turn is bounded only by
     *  the idle watchdog: run 12's planner was killed by the effort ladder
     *  8 minutes into a productive turn, right after publishing a fragment. */
    timeoutMs?: number
}

export async function runPlannerClaude(
    opts: RunPlannerClaudeOptions,
): Promise<string> {
    const modeContract = opts.modeContract ?? await runClaudeIntake(opts).catch((e) => {
        process.stderr.write(`[planner-claude] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    process.stderr.write(`[planner-claude] intake mode=${modeContract.mode} confidence=${modeContract.confidence}\n`)
    const userMessage = buildPlannerUserMessage({
        goal: opts.goal,
        decisionDocument: opts.decisionDocument,
        quick: opts.quick,
        projectContext: opts.projectContext,
        modeContract,
    })

    const progressive = await createPlannerHarnessProgressiveSupport(
        opts.progressive,
    )
    try {
        const systemPrompt = progressive.systemInstruction
            ? `${PLANNER_SYSTEM_PROMPT}\n\n${progressive.systemInstruction}`
            : PLANNER_SYSTEM_PROMPT
        // A spawned CLI is exactly who the relay exists for.
        if (opts.progressive) await progressive.openMcpConnection()
        const mcpConfig = progressive.mcpConnection
            ? JSON.stringify({
                  mcpServers: {
                      [PROGRESSIVE_PLANNER_MCP_SERVER_NAME]: {
                          type: "stdio",
                          command: progressive.mcpConnection.command,
                          args: progressive.mcpConnection.args,
                          // Claude expands ${VAR} from its own environment.
                          // The secret value therefore never enters argv.
                          env: inheritedEnvironmentReferences(
                              progressive.mcpConnection.providerEnvironment,
                          ),
                      },
                  },
              })
            : null
        const progressiveTool =
            `mcp__${PROGRESSIVE_PLANNER_MCP_SERVER_NAME}__publish_plan_fragment`
        // stream-json with partial messages turns the turn into a per-token
        // heartbeat: the idle watchdog then only fires on a genuinely stalled
        // process, never on a long think.
        const collector = new ClaudeStreamResultCollector()
        await execFileCli(
            opts.claudeBin ?? "claude",
            [
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                ...(mcpConfig
                    ? [
                          // `--safe-mode` disables even explicitly supplied
                          // MCP servers. An empty setting-source list keeps
                          // ambient user/project settings out while the exact
                          // run-scoped server remains available.
                          "--setting-sources",
                          "",
                          "--disable-slash-commands",
                          "--no-session-persistence",
                          "--strict-mcp-config",
                          "--mcp-config",
                          mcpConfig,
                          "--tools",
                          `Read,Glob,Grep,${progressiveTool}`,
                          "--allowed-tools",
                          progressiveTool,
                      ]
                    : []),
                ...(opts.model ? ["--model", opts.model] : []),
                ...(opts.effort ? ["--effort", opts.effort] : []),
                "--permission-mode",
                mcpConfig ? "dontAsk" : "bypassPermissions",
                "--system-prompt",
                systemPrompt,
                "-p",
                userMessage,
            ],
            {
                cwd: opts.cwd,
                env: {
                    ...harnessChildEnvironment(),
                    ...(progressive.mcpConnection?.providerEnvironment ?? {}),
                },
                ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
                idleTimeoutMs: llmIdleTimeoutMs(),
                maxBuffer: 16 * 1024 * 1024,
                onStdoutData: (chunk) => collector.feed(chunk),
            },
        )

        const resultLine = collector.resultLine()
        if (!resultLine) {
            throw new Error(
                "PlannerClaude: stream ended without a result event",
            )
        }
        const wrapper = JSON.parse(resultLine) as { result?: string }
        const planText = typeof wrapper.result === "string" ? wrapper.result.trim() : ""
        if (!planText) {
            throw new Error("PlannerClaude: claude returned empty result")
        }
        // The model occasionally wraps the JSON in a markdown fence or adds
        // prose despite the "ONLY JSON" instruction — strip back to a bare `{ … }`.
        const candidate = extractJsonObject(planText)
        progressive.assertInitialized()
        progressive.reconcileFinalCandidate(candidate)
        return candidate
    } finally {
        await progressive.close()
    }
}

export async function runClaudeIntake(opts: RunPlannerClaudeOptions) {
    if (opts.quick) return heuristicModeContract(opts)
    const { stdout } = await execFileCli(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "json",
            "--safe-mode",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--tools",
            "",
            ...(opts.model ? ["--model", opts.model] : []),
            ...(opts.effort ? ["--effort", opts.effort] : []),
            "--permission-mode",
            "dontAsk",
            "--system-prompt",
            "You classify software tasks for an autonomous PR workflow. Output JSON only.",
            "-p",
            buildIntakePrompt(opts),
        ],
        {
            cwd: opts.cwd,
            env: harnessChildEnvironment(),
            ...(opts.timeoutMs ? { timeout: Math.min(opts.timeoutMs, 180_000) } : {}),
            idleTimeoutMs: llmIdleTimeoutMs(),
            maxBuffer: 2 * 1024 * 1024,
        },
    )
    const wrapper = JSON.parse(stdout) as { result?: string }
    const text = typeof wrapper.result === "string" ? wrapper.result.trim() : ""
    if (!text) throw new Error("empty intake result")
    return parseModeContract(text)
}

function inheritedEnvironmentReferences(
    values: Readonly<Record<string, string>>,
): Record<string, string> {
    return Object.fromEntries(
        Object.keys(values).map((key) => [key, "${" + key + "}"]),
    )
}

/** First balanced `{ … }` block; tolerates markdown fences and leading prose. */
function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(
            `PlannerClaude: no JSON object in response: ${trimmed.slice(0, 200)}`,
        )
    }
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth++
        else if (ch === "}") {
            depth--
            if (depth === 0) return trimmed.slice(start, i + 1)
        }
    }
    throw new Error(
        `PlannerClaude: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
