/**
 * PlannerClaude — one Planner turn via `claude --print`, optionally with a
 * live progressive-planning MCP tool during that turn.
 * Returns the raw PRD JSON string; the Rust caller deserialises it
 * (`PrdOutput`) so the schema has a single source of truth.
 */

import { execFileCli } from "../exec-file-cli.js"

import { harnessChildEnvironment } from "../harness-environment.js"

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
} from "./planner-prompts.js"

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
    /** Defaults scale with `effort` ({@link effortTimeoutMs}) — the flat
     *  4-minute default was SIGTERM'ing `--effort max` runs mid-thought. */
    timeoutMs?: number
}

/** Higher effort = longer single `--print` turns, so the watchdog waits longer. */
export function effortTimeoutMs(effort?: string): number {
    switch (effort) {
        case "max":
            return 1_200_000 // 20 min
        case "xhigh":
            return 900_000 // 15 min
        case "high":
            return 480_000 // 8 min
        default:
            return 240_000 // 4 min (low | medium | unset)
    }
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
        const { stdout } = await execFileCli(
            opts.claudeBin ?? "claude",
            [
                "--print",
                "--output-format",
                "json",
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
                timeout: opts.timeoutMs ?? effortTimeoutMs(opts.effort),
                maxBuffer: 16 * 1024 * 1024,
            },
        )

        const wrapper = JSON.parse(stdout) as { result?: string }
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
            timeout: Math.min(opts.timeoutMs ?? effortTimeoutMs(opts.effort), 180_000),
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
