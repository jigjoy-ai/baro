/**
 * PlannerCodex — one Planner turn via `codex exec --json`, optionally with a
 * live progressive-planning MCP tool during that turn.
 *
 * Same prompt shape as PlannerClaude / PlannerOpenAI. Returns the raw
 * PRD JSON string for the Rust caller to deserialise.
 */

import { realpathSync } from "node:fs"

import { runCodexOneShot } from "../codex-one-shot.js"
import {
    createPlannerHarnessProgressiveSupport,
    PROGRESSIVE_PLANNER_MCP_SERVER_NAME,
    PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
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

export interface RunPlannerCodexOptions {
    goal: string
    cwd: string
    model?: string
    effort?: "low" | "medium" | "high" | "xhigh" | "max"
    projectContext?: string
    decisionDocument?: string
    quick?: boolean
    /** Pre-decided contract (user pick or run-intake step); skips this planner's own intake. */
    modeContract?: ModeContract
    codexBin?: string
    /** Collective-only early-plan tool exposed through an isolated MCP server. */
    progressive?: PlannerHarnessProgressiveConfig
    /** Default 15 min — large multi-story PRDs pushed Codex past the
     *  old 4-minute ceiling. */
    timeoutMs?: number
}

export async function runPlannerCodex(
    opts: RunPlannerCodexOptions,
): Promise<string> {
    const modeContract = opts.modeContract ?? await runCodexIntake(opts).catch((e) => {
        process.stderr.write(`[planner-codex] intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic mode contract\n`)
        return heuristicModeContract(opts)
    })
    process.stderr.write(`[planner-codex] intake mode=${modeContract.mode} confidence=${modeContract.confidence}\n`)
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
        const prompt = progressive.systemInstruction
            ? `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}\n\n${progressive.systemInstruction}`
            : `${PLANNER_SYSTEM_PROMPT}\n\n${userMessage}`

        const text = await runCodexOneShot({
            prompt,
            cwd: opts.cwd,
            model: opts.model,
            reasoningEffort: opts.effort,
            codexBin: opts.codexBin,
            timeoutMs: opts.timeoutMs ?? 900_000,
            label: "codex-planner",
            ...(progressive.mcpConnection
                ? {
                      // Authentication remains in CODEX_HOME. Configuration,
                      // hooks, rules, writes and web access do not enter this
                      // private read-only planning turn.
                      bypassSandbox: false,
                      sandboxMode: "read-only" as const,
                      ephemeral: true,
                      ignoreUserConfig: true,
                      ignoreRules: true,
                      disableHooks: true,
                      neverApprove: true,
                      disableWebSearch: true,
                      untrustedProjectPath: realpathSync(opts.cwd),
                      additionalEnvironment:
                          progressive.mcpConnection.providerEnvironment,
                      mcpServer: {
                          name: PROGRESSIVE_PLANNER_MCP_SERVER_NAME,
                          command: progressive.mcpConnection.command,
                          args: progressive.mcpConnection.args,
                          envVars: Object.keys(
                              progressive.mcpConnection.providerEnvironment,
                          ),
                          enabledTools: [PROGRESSIVE_PLANNER_MCP_TOOL_NAME],
                      },
                  }
                : {}),
        })

        const planText = text.trim()
        if (!planText) {
            throw new Error("PlannerCodex: codex returned empty result")
        }
        // Model sometimes wraps JSON in markdown fences or adds prose despite
        // the "ONLY JSON" instruction — strip back to a bare `{ … }`.
        const candidate = extractJsonObject(planText)
        progressive.assertInitialized()
        progressive.reconcileFinalCandidate(candidate)
        return candidate
    } finally {
        await progressive.close()
    }
}

export async function runCodexIntake(opts: RunPlannerCodexOptions) {
    if (opts.quick) return heuristicModeContract(opts)
    const text = await runCodexOneShot({
        prompt: `You classify software tasks for an autonomous PR workflow. Output JSON only.\n\n${buildIntakePrompt(opts)}`,
        cwd: opts.cwd,
        model: opts.model,
        codexBin: opts.codexBin,
        timeoutMs: Math.min(opts.timeoutMs ?? 900_000, 180_000),
        label: "codex-intake",
        // Intake receives every fact it needs in the prompt. It must not
        // mutate or inspect the checkout, load ambient customizations, ask
        // interactively, or expose the user's shell environment to commands.
        bypassSandbox: false,
        isolateToolFilesystem: true,
        ephemeral: true,
        ignoreUserConfig: true,
        ignoreRules: true,
        disableHooks: true,
        untrustedProjectPath: realpathSync(opts.cwd),
        disableProjectDocs: true,
    })
    return parseModeContract(text.trim())
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
            `PlannerCodex: no JSON object in response: ${trimmed.slice(0, 200)}`,
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
        `PlannerCodex: unbalanced JSON in response: ${trimmed.slice(0, 200)}`,
    )
}
