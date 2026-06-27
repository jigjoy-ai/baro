/**
 * High-level entry: build a Mozaik environment with all the standard
 * baro participants, run a PRD to completion, return a summary.
 *
 * Used by:
 *   - the Rust orchestrator client (via run-orchestrator.ts)
 *   - direct TS callers (tests, demos)
 */

import { mkdirSync } from "fs"
import { dirname, join } from "path"

import { AgenticEnvironment } from "@mozaik-ai/core"

import {
    GitGate,
    createOrCheckoutBranch,
    getGitFileStats,
    getHeadSha,
    gitPushWithRetry,
    isInsideGitRepo,
    safePullRebase,
} from "./git.js"
import { WorktreeManager } from "./worktree.js"
import { buildDag } from "./dag.js"
import {
    formatRoute,
    resolveStoryRoute,
    type ResolveOpts,
} from "./routing.js"
import { Auditor } from "./participants/auditor.js"
import {
    Conductor,
    ConductorRunSummary,
} from "./participants/conductor.js"
import { Critic } from "./participants/critic.js"
import { CriticCodex } from "./participants/critic-codex.js"
import { CriticOpenAI } from "./participants/critic-openai.js"
import { CriticOpenCode } from "./participants/critic-opencode.js"
import { CriticPi } from "./participants/critic-pi.js"
import { Finalizer } from "./participants/finalizer.js"
import { joinBaroEventForwarders } from "./participants/forwarders/index.js"
import { Librarian } from "./participants/librarian.js"
import { MemoryLibrarian } from "./participants/memory-librarian.js"
import { Operator } from "./participants/operator.js"
import { Sentry } from "./participants/sentry.js"
import { StoryFactory } from "./participants/story-factory.js"
import { type StoryAgent } from "./participants/story-agent.js"
import {
    Surgeon,
    type PrdSnapshot,
    type RouteDescriber,
} from "./participants/surgeon.js"
import { SurgeonCodex } from "./participants/surgeon-codex.js"
import { SurgeonOpenAI } from "./participants/surgeon-openai.js"
import { SurgeonOpenCode } from "./participants/surgeon-opencode.js"
import { SurgeonPi } from "./participants/surgeon-pi.js"
import { PrdFile, loadPrd } from "./prd.js"
import { RunStartRequest } from "./semantic-events.js"
import { emit } from "./tui-protocol.js"

export interface OrchestrateConfig {
    prdPath: string
    cwd: string
    parallel?: number
    timeoutSecs?: number
    overrideModel?: string | null
    defaultModel?: string
    /** Optional path for the audit JSONL log. If omitted, no Auditor joins. */
    auditLogPath?: string
    /**
     * If true, BaroEvents are emitted to stdout for a TUI consumer.
     * Default: true.
     */
    emitTuiEvents?: boolean
    /**
     * Whether to perform git lifecycle operations (branch create, push,
     * pull --rebase between stories). If undefined, auto-detected from
     * whether `cwd` is a git working tree.
     */
    withGit?: boolean
    /**
     * Whether to wire the Librarian (cross-agent runtime memory) into
     * the run. When on, prompts for stories at later DAG levels are
     * automatically augmented with relevant findings from earlier
     * stories. Default: true.
     */
    withLibrarian?: boolean
    /**
     * Whether to use semantic memory (MemoryLibrarian with Vectra) instead
     * of the tag-based Librarian. Uses ONNX embeddings + Vectra local
     * vector DB for cosine similarity search. Same interface, better
     * context matching, cross-process sharing via disk persistence.
     * Default: true (when withLibrarian is true).
     * Pass false (or --no-memory CLI flag) to fall back to tag-based.
     */
    withMemory?: boolean
    /**
     * Whether to wire the Sentry (file-touch conflict detector). When
     * on, overlapping Edit/Write tool calls across agents emit
     * CoordinationItem warnings on the bus. Default: true.
     */
    withSentry?: boolean
    /**
     * Whether to wire the Critic (live acceptance-criteria evaluator).
     * When on, each story agent's output is evaluated against its
     * acceptance criteria via a `claude --model haiku` subprocess. Auth
     * comes through the Claude CLI's existing config — no API key needed.
     * Default: false (opt-in).
     */
    withCritic?: boolean
    /**
     * Model passed to the Critic when withCritic is on. Default: "haiku".
     * Use any alias `claude --model` accepts ("haiku", "sonnet", "opus")
     * or a fully qualified ID.
     */
    criticModel?: string
    /**
     * Whether to wire the Surgeon (Phase 4 adaptive DAG mutation).
     * When on, terminal story failures trigger ReplanItem-s that
     * Conductor applies at the next level boundary. Default: false.
     */
    withSurgeon?: boolean
    /**
     * Use Claude CLI (claude --model …) for Surgeon evaluation.
     * Default: false (deterministic skip-only strategy). Setting true
     * costs tokens but lets Surgeon propose richer replans (split,
     * insert prerequisite, rewire deps).
     */
    surgeonUseLlm?: boolean
    /** Model for the Surgeon LLM. Default: "opus". */
    surgeonModel?: string
    /**
     * Seconds to wait between successive story spawns inside the
     * same DAG level. Passed through to Conductor. Default: 10.
     * Set to 0 to disable staggering.
     */
    intraLevelDelaySecs?: number
    /**
     * Run each story in its own git worktree (issue #50) instead of a shared
     * working tree. Default: true when git lifecycle is on. Set false to keep
     * the old shared-tree behaviour.
     */
    withWorktrees?: boolean
    /**
     * Symlink dependency dirs (node_modules, …) from the repo root into each
     * story worktree so builds/tests resolve. Default: true. Only relevant
     * when withWorktrees is on.
     */
    worktreeLinkDepDirs?: boolean
    /**
     * Which LLM provider drives the agents. `"claude"` (the current
     * default) uses the Claude Code CLI for Architect, Planner,
     * StoryAgent, Critic, and Surgeon. `"openai"` is wired through
     * end-to-end but no participant yet routes to Mozaik's native
     * OpenAI runner — each subsequent phase replaces one fallback with
     * a real OpenAI sibling. Until then, `"openai"` is a no-op
     * placeholder that runs the Claude flow.
     *
     * `"codex"` is the subscription-arbitrage path via OpenAI Codex CLI
     * (ChatGPT Plus/Pro billing). All phases route through Codex.
     *
     * This `llm` field is the **default** every Story/Critic/Surgeon
     * phase uses unless an explicit per-phase override
     * (`storyLlm`/`criticLlm`/`surgeonLlm`) is set below. Architect +
     * Planner phases are wired up in the Rust TUI layer, not here —
     * orchestrate.ts doesn't see them.
     */
    llm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    /**
     * Optional per-phase overrides. When set, win over `llm`. Each can
     * be any of the three providers, independent of the others. Used
     * by the `--llm hybrid` preset (Story+Critic on Codex bulk-savings,
     * Surgeon on Claude for rare-but-high-stakes failures).
     */
    storyLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    criticLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    surgeonLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    /**
     * Per-phase model override for StoryAgent. When set, wins over
     * each story's individual `model` field in the PRD as well as
     * over the OpenAI default. Plumbed from the Rust CLI flag
     * `--story-model`.
     */
    storyModel?: string
    /**
     * Effort level for the Claude story path, passed as `claude
     * --effort` (low|medium|high|xhigh|max). Plumbed from `baro
     * --effort`. Only the Claude backend honours it.
     */
    effort?: string
    /**
     * Tier→`backend:model` bindings (from `--tier-map` / `BARO_TIER_MAP`).
     * Binds the Planner's per-story blast-radius tier (haiku/sonnet/opus)
     * to a concrete backend+model, so a single DAG can route cheap
     * single-concern stories to one backend and cross-cutting stories to
     * another. Absent → per-story tiers resolve on the phase `llm` as
     * before.
     */
    tierMap?: import("./routing.js").TierMap
    /**
     * Named OpenAI-compatible endpoints (from `--openai-endpoint`).
     * Routes of the form `openai:model@name` resolve their base URL + key
     * here, so one DAG can hit several OpenAI-compatible endpoints (e.g.
     * MiniMax + real OpenAI) at once.
     */
    openaiEndpoints?: import("./routing.js").EndpointMap
    /**
     * Where story agents run. Default: in-process (`LocalStoryExecutor`).
     * Pass a custom `StoryExecutor` to run the agent loop elsewhere (a mock for
     * tests, or an out-of-process / remote executor) without changing any other
     * participant.
     */
    executor?: import("./participants/story-executor.js").StoryExecutor
    /** Hooks for receiving Operator commands externally (Rust TUI). */
    operatorHooks?: {
        onAbort?: (storyId: string) => void
        onAbortAll?: () => void
        onShutdown?: () => void
    }
    /**
     * Extra participants to attach to the bus before the run starts.
     * Useful for live debugging, custom observers, or test harnesses.
     */
    extraParticipants?: import("@mozaik-ai/core").Participant[]
}

/**
 * Resolve the per-story timeout (seconds).
 *
 * `--timeout N` (any positive value) is an **absolute override** — it wins
 * in both directions, so you can shorten OR lengthen the cap explicitly and
 * nothing here second-guesses it.
 *
 * When `--timeout` is NOT set (`configured` is 0 or undefined — the Rust CLI
 * sends 0 to mean "auto"), the default is **scaled by effort** rather than a
 * hard-coded 600s: a single `--effort max` Opus story (write the layer + its
 * specs + run the suite) routinely exceeds 600s and gets SIGTERM'd (exit 143
 * → wasted full retry; observed: story S8 killed at 600s on a pure-Opus run).
 * low/medium keep the prior 600s. Codex stories finish well under any of
 * these, so the effort default only ever matters on the Claude path.
 */
export function storyTimeoutSecs(
    configured: number | undefined,
    effort: string | undefined,
): number {
    if (typeof configured === "number" && configured > 0) return configured
    switch (effort) {
        case "max":
            return 1500
        case "xhigh":
            return 1200
        case "high":
            return 900
        default:
            return 600
    }
}

export interface OrchestrateResult {
    summary: ConductorRunSummary
    operator: Operator
    /** Active StoryAgents indexed by id, exposed for outside abort/inspection. */
    storyAgents: Map<string, StoryAgent>
}

/**
 * Build, run, and tear down the orchestration environment for a single
 * PRD execution.
 */
export async function orchestrate(
    config: OrchestrateConfig,
): Promise<OrchestrateResult> {
    // Harden the environment so the tools agents run never hang on a prompt or a watcher,
    // on ANY stack. Set once here (the chokepoint every run goes through); child agents
    // spawn inheriting process.env, so this reaches every shell command they issue.
    //  - CI=1            → vitest/jest/playwright/pytest run once, no watch, no prompts
    //  - npm_config_yes  → `npx <tool>` auto-confirms instead of "Ok to proceed? (y)"
    //  - *_PROMPT/INPUT  → pip/git/apt never block waiting on a TTY
    for (const [k, v] of Object.entries({
        CI: "1",
        npm_config_yes: "true",
        npm_config_fund: "false",
        npm_config_audit: "false",
        PIP_NO_INPUT: "1",
        GIT_TERMINAL_PROMPT: "0",
        DEBIAN_FRONTEND: "noninteractive",
    })) {
        if (process.env[k] === undefined) process.env[k] = v
    }
    const env = new AgenticEnvironment()
    const emitTui = config.emitTuiEvents ?? true
    const llm: "claude" | "openai" | "codex" | "opencode" | "pi" = config.llm ?? "claude"
    // Per-phase resolution: each falls back to global `llm` when no
    // explicit override is provided. This is the central place where
    // hybrid configurations land — every downstream factory branches
    // on storyLlm / criticLlm / surgeonLlm, not on the global `llm`.
    const storyLlm = config.storyLlm ?? llm
    const criticLlm = config.criticLlm ?? llm
    const surgeonLlm = config.surgeonLlm ?? llm

    // The Critic listens for AgentResult on the bus. The CLI-subprocess
    // story backends (pi, opencode) emit StoryResult/AgentState and never
    // AgentResult, so the Critic is silent whenever the STORY backend is one
    // of them — regardless of which backend the Critic itself runs on. (The
    // critic backend choice only affects which model evaluates; it can't
    // observe what the story never emits.) Warn loudly rather than failing
    // quietly. `--critic-llm pi` over a Claude/OpenAI story still works,
    // because those story backends DO emit AgentResult.
    if (config.withCritic) {
        const noAgentResult = new Set(["pi", "opencode"])
        if (noAgentResult.has(storyLlm)) {
            process.stderr.write(
                `[orchestrate] WARNING: --with-critic with story backend '${storyLlm}' — ` +
                    `the ${storyLlm} backend emits no AgentResult, so the Critic will never fire. ` +
                    `Use a Claude/OpenAI story backend, or set --story-llm to a different backend.\n`,
            )
        }
    }

    // Provider banner so the stderr / audit log makes the actual
    // routing obvious. As of 0.33 every LLM-using phase (Architect,
    // Planner, Critic, Surgeon, StoryAgent) routes end-to-end to the
    // selected provider — no mixed-mode anymore.
    // Per-phase banner so the audit log spells out exactly which
    // backend each in-process phase uses. Architect + Planner are
    // run by the Rust TUI as separate subprocesses — their llm
    // routing is logged in their own banners.
    const isHybrid =
        new Set([storyLlm, criticLlm, surgeonLlm, llm]).size > 1
    if (config.tierMap && Object.keys(config.tierMap).length > 0) {
        const pairs = Object.entries(config.tierMap)
            .map(([tier, route]) => `${tier}→${route}`)
            .join(" ")
        process.stderr.write(
            `[orchestrate] per-story tier map (fallback backend=${storyLlm}): ${pairs}\n`,
        )
    }
    if (config.openaiEndpoints && Object.keys(config.openaiEndpoints).length > 0) {
        const eps = Object.entries(config.openaiEndpoints)
            .map(([name, ep]) => `${name}→${ep.baseUrl}${ep.apiKey ? "" : " (no key!)"}`)
            .join(" ")
        process.stderr.write(`[orchestrate] openai endpoints: ${eps}\n`)
    }
    if (isHybrid) {
        process.stderr.write(
            `[orchestrate] hybrid routing: story=${storyLlm} critic=${criticLlm} surgeon=${surgeonLlm} (default=${llm})\n`,
        )
    } else if (llm === "openai") {
        process.stderr.write(
            "[orchestrate] llm=openai: Story, Critic, Surgeon all running through " +
                "Mozaik's native OpenAI runner (gpt-5.x).\n",
        )
    } else if (llm === "codex") {
        process.stderr.write(
            "[orchestrate] llm=codex: Story, Critic, Surgeon all shelling out to " +
                "`codex exec --json` (ChatGPT subscription path).\n",
        )
    } else if (llm === "opencode") {
        process.stderr.write(
            "[orchestrate] llm=opencode: Story, Critic, Surgeon all shelling out to " +
                "`opencode run --format json` (OpenCode CLI path).\n",
        )
    } else if (llm === "pi") {
        process.stderr.write(
            "[orchestrate] llm=pi: Story, Critic, Surgeon all shelling out to " +
                "`pi --mode json -p` (Pi CLI path).\n",
        )
    } else {
        process.stderr.write(
            "[orchestrate] llm=claude: Story, Critic, Surgeon all shelling out to " +
                "the Claude Code CLI.\n",
        )
    }

    // Optional audit log (resume + post-mortem).
    if (config.auditLogPath) {
        mkdirSync(dirname(config.auditLogPath), { recursive: true })
        new Auditor({ path: config.auditLogPath }).join(env)
    }

    // Extra observers (live loggers, custom debuggers, test harnesses).
    if (config.extraParticipants) {
        for (const p of config.extraParticipants) p.join(env)
    }

    // BaroEvent forwarder: watch the bus, translate to TUI protocol on stdout.
    if (emitTui) {
        joinBaroEventForwarders(env)
    }

    // Operator listens for external commands (wired from caller).
    const operator = new Operator(config.operatorHooks ?? {})
    operator.setEnvironment(env)
    operator.join(env)

    const useGit = config.withGit ?? (await isInsideGitRepo(config.cwd))
    const gitGate = new GitGate()
    let baseSha: string | null = null

    // Unique per-run id, shared by the memory session path and the per-story
    // worktree branch/dir names so concurrent runs and resumes never collide.
    const runId = `run-${Date.now()}-${process.pid}`

    // Escape hatch: explicit config wins; else the presence of
    // BARO_NO_WORKTREES disables it (NO_COLOR-style — set to ANY value,
    // including empty, to turn worktrees off) without needing Rust CLI flag
    // plumbing; else on by default.
    const worktreesEnabled =
        config.withWorktrees ?? !("BARO_NO_WORKTREES" in process.env)
    const worktrees =
        useGit && worktreesEnabled
            ? new WorktreeManager(config.cwd, gitGate, runId, {
                  linkDepDirs: config.worktreeLinkDepDirs ?? true,
                  onLog: (line) =>
                      emitTui && emit({ type: "story_log", id: "_git", line }),
              })
            : null
    // Fallback/non-worktree story pushes run off the Conductor's critical
    // path (see onStoryPassed); awaited before the run finishes so none is
    // lost. Worktree merge-backs accumulate on the LOCAL run branch and are
    // pushed once at the end (worktreePushNeeded) instead — a per-story push
    // would re-stall the Conductor, since it shares gitGate with the
    // on-critical-path merge-back.
    const storyPushes: Promise<void>[] = []
    let worktreePushNeeded = false

    // Phase-2 observers — Librarian (cross-agent memory) and Sentry
    // (file conflict detection). Both default ON; either can be turned
    // off via the OrchestrateConfig flags.
    const useLibrarian = config.withLibrarian ?? true
    const useSentry = config.withSentry ?? true
    const useMemory = config.withMemory ?? true

    // Generate a session-scoped memory path for cross-process sharing.
    // Vectra index + cache.json live here. CLI reads BARO_MEMORY_PATH.
    // Include PID to prevent collision if two orchestrators start simultaneously.
    const sessionsDir = join(process.env.HOME || "/tmp", ".baro", "sessions")
    const memorySessionPath = useMemory
        ? join(sessionsDir, runId, "memory")
        : undefined

    // Prune stale session directories (>24h old) to prevent unbounded growth.
    if (useMemory) {
        try {
            const { pruneOldSessions } = await import("@baro/memory")
            pruneOldSessions(sessionsDir)
        } catch { /* non-critical */ }
    }

    // Expose path via env so child processes (story agents) inherit it.
    if (memorySessionPath) {
        process.env.BARO_MEMORY_PATH = memorySessionPath
    }

    // Use MemoryLibrarian (Vectra-backed semantic) when memory is enabled,
    // otherwise fall back to tag-based Librarian.
    const librarian = useLibrarian
        ? (useMemory ? new MemoryLibrarian({ sessionPath: memorySessionPath }) : new Librarian())
        : null
    const sentry = useSentry ? new Sentry() : null
    if (librarian) librarian.join(env)
    if (sentry) sentry.join(env)

    // Phase-4 observer — Surgeon (adaptive DAG mutation). Opt-in.
    // Joins early so it sees StoryResultItem-s from the moment the
    // Conductor starts running.
    let surgeon: Surgeon | SurgeonOpenAI | SurgeonCodex | SurgeonOpenCode | SurgeonPi | null = null
    if (config.withSurgeon) {
        const snapshot = (): PrdSnapshot => {
            const current = loadPrd(config.prdPath)
            return {
                project: current.project,
                description: current.description,
                stories: current.userStories.map((s) => ({
                    id: s.id,
                    title: s.title,
                    description: s.description,
                    dependsOn: s.dependsOn,
                    passes: s.passes,
                    model: s.model,
                })),
            }
        }
        // Tell the Surgeon what a story's planner tier actually resolved to,
        // so its replan reason names the model that ran rather than the tier
        // an override replaced (issue #48). Only wired when an override is in
        // play — on a plain run the tier IS the model, so we keep showing it.
        const storyRouting: ResolveOpts = {
            fallbackBackend: storyLlm,
            openaiDefaultModel: config.storyModel ?? "gpt-5.5",
            override: config.storyModel,
            tierMap: config.tierMap,
            endpoints: config.openaiEndpoints,
            defaultApiKey: process.env.OPENAI_API_KEY,
        }
        const routingOverridden =
            storyLlm !== "claude" || !!config.storyModel || !!config.tierMap
        const resolveRoute: RouteDescriber | undefined = routingOverridden
            ? (model) => {
                  try {
                      return formatRoute(resolveStoryRoute(model, storyRouting))
                  } catch {
                      return null
                  }
              }
            : undefined
        // Factory by provider. Bus contract is identical across all
        // three — same ReplanItem shape — so downstream observers
        // (Conductor's replan-applier, Auditor, kaleidoskop) don't
        // notice the swap.
        if (surgeonLlm === "openai") {
            surgeon = new SurgeonOpenAI({
                snapshot,
                resolveRoute,
                model: config.surgeonModel ?? "gpt-5.5",
            })
        } else if (surgeonLlm === "codex") {
            surgeon = new SurgeonCodex({
                snapshot,
                resolveRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
            })
        } else if (surgeonLlm === "opencode") {
            surgeon = new SurgeonOpenCode({
                snapshot,
                resolveRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
            })
        } else if (surgeonLlm === "pi") {
            surgeon = new SurgeonPi({
                snapshot,
                resolveRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
            })
        } else {
            surgeon = new Surgeon({
                snapshot,
                resolveRoute,
                useLlm: config.surgeonUseLlm ?? false,
                model: config.surgeonModel ?? "opus",
            })
        }
        surgeon.join(env)
    }

    // Phase-3 observer — Critic (live acceptance-criteria evaluator).
    // Opt-in (default OFF). Spawns `claude --model haiku` subprocesses
    // for each evaluation, inheriting Claude CLI auth.
    let critic: Critic | CriticOpenAI | CriticCodex | CriticOpenCode | CriticPi | null = null
    if (config.withCritic) {
        const prd = loadPrd(config.prdPath)
        const targets = new Map<string, readonly string[]>(
            prd.userStories
                .filter((s) => s.acceptance && s.acceptance.length > 0)
                .map((s) => [s.id, s.acceptance] as [string, readonly string[]]),
        )
        // Factory by provider. Bus contract is identical — same
        // CritiqueItem shape, same AgentTargetedMessageItem corrective
        // emission — so downstream observers (Cartographer, Auditor,
        // kaleidoskop) don't notice the swap.
        if (criticLlm === "openai") {
            critic = new CriticOpenAI({
                targets,
                model: config.criticModel ?? "gpt-5.4-mini",
            })
        } else if (criticLlm === "codex") {
            critic = new CriticCodex({
                targets,
                model: config.criticModel,
            })
        } else if (criticLlm === "opencode") {
            critic = new CriticOpenCode({
                targets,
                model: config.criticModel,
            })
        } else if (criticLlm === "pi") {
            critic = new CriticPi({
                targets,
                model: config.criticModel,
            })
        } else {
            critic = new Critic({
                targets,
                model: config.criticModel ?? "haiku",
            })
        }
        critic.join(env)
    }

    // Finalizer — opens the PR at the end of the run, listening on the
    // bus for the canonical end-of-run signals. Only joins when we're
    // doing git lifecycle (no point composing a PR for a no-commit run)
    // — `gh` availability is checked inside Finalizer itself so the run
    // still succeeds even on machines without it.
    const finalizer = useGit
        ? new Finalizer({
              cwd: config.cwd,
              prdPath: config.prdPath,
              onLog: (line) =>
                  emitTui && emit({ type: "story_log", id: "_finalizer", line }),
          })
        : null
    if (finalizer) {
        finalizer.setEnvironment(env)
        finalizer.join(env)
    }

    // Conductor — the work driver.
    const conductor = new Conductor({
        prdPath: config.prdPath,
        cwd: config.cwd,
        parallel: config.parallel ?? 0,
        timeoutSecs: storyTimeoutSecs(config.timeoutSecs, config.effort),
        overrideModel: config.overrideModel ?? undefined,
        defaultModel: config.defaultModel ?? "opus",
        intraLevelDelaySecs: config.intraLevelDelaySecs,
        onRunStart: useGit
            ? async (prd) => {
                  baseSha = await getHeadSha(config.cwd)
                  if (prd.branchName) {
                      await createOrCheckoutBranch(
                          config.cwd,
                          prd.branchName,
                          (line) => emitTui && emit({ type: "story_log", id: "_git", line }),
                      )
                  }
                  await worktrees?.cleanupStaleOnStart()
              }
            : undefined,
        onBeforeStoryLaunch: librarian
            ? (storyId, story) => {
                  // Build hints from the story title + a few description
                  // tokens so Librarian can rank relevance.
                  const hints: string[] = [
                      ...tokenizeForHints(story.title),
                      ...tokenizeForHints(story.description).slice(0, 8),
                  ]
                  return librarian.gatherContext(storyId, hints)
              }
            : undefined,
        onStoryPassed: useGit
            ? async (storyId) => {
                  const log = (line: string) =>
                      emitTui && emit({ type: "story_log", id: storyId, line })
                  // Merge the story into the run branch on the critical path
                  // (fast, local) so the next DAG level sees it. mergeBack
                  // returns false when the story had no worktree (create()
                  // fell back to the shared tree) — that story still needs the
                  // shared-tree remote reconciliation.
                  if (worktrees) {
                      let merged = false
                      try {
                          merged = await worktrees.mergeBack(storyId)
                      } catch (e) {
                          // Unresolvable merge: keep the worktree + branch so
                          // the passed work can be recovered, don't push/clean.
                          log(`[git] merge-back failed; worktree preserved for recovery: ${(e as Error)?.message ?? String(e)}`)
                          if (emitTui) {
                              emit({ type: "push_status", id: storyId, success: false, error: (e as Error)?.message ?? String(e) })
                          }
                          return
                      }
                      if (merged) {
                          // Cleanup is fast + local; the run branch is pushed
                          // once after the run (worktreePushNeeded) so this
                          // critical-path callback never waits on the network.
                          await worktrees.cleanup(storyId)
                          worktreePushNeeded = true
                          if (emitTui) {
                              emit({ type: "push_status", id: storyId, success: true, error: null })
                          }
                          return
                      }
                      // merged === false → story fell back to the shared tree;
                      // reconcile + push it like the non-worktree path below.
                  }
                  await safePullRebase(config.cwd, log, gitGate)
                  storyPushes.push(
                      (async () => {
                          try {
                              await gitPushWithRetry(gitGate, { cwd: config.cwd, onLog: log })
                              if (emitTui) {
                                  emit({ type: "push_status", id: storyId, success: true, error: null })
                              }
                          } catch (e) {
                              if (emitTui) {
                                  emit({ type: "push_status", id: storyId, success: false, error: (e as Error)?.message ?? String(e) })
                              }
                          }
                      })(),
                  )
              }
            : undefined,
        onStoryFailed: worktrees
            ? (storyId) => worktrees.cleanup(storyId)
            : undefined,
    })
    conductor.setEnvironment(env)
    conductor.join(env)

    // Story factory — Mozaik-native participant that spawns StoryAgent
    // instances in response to StorySpawnRequestItem from Conductor.
    // Replaces the old `new StoryAgent(...).run()` direct call inside
    // Conductor; now Conductor doesn't import StoryAgent at all.
    // When --llm openai is set, story execution runs through
    // OpenAIStoryAgent (Mozaik OpenAIResponses + our tool layer);
    // otherwise the Claude CLI subprocess path. StoryFactory dispatches
    // per-spawn, so future per-story overrides could live there too.
    const storyFactory = new StoryFactory({
        cwd: config.cwd,
        worktrees: worktrees ?? undefined,
        llm: storyLlm,
        openaiModel: config.storyModel ?? "gpt-5.5",
        storyModelOverride: config.storyModel,
        effort: config.effort,
        tierMap: config.tierMap,
        endpoints: config.openaiEndpoints,
        defaultApiKey: process.env.OPENAI_API_KEY,
        executor: config.executor,
    })
    storyFactory.setEnvironment(env)
    storyFactory.join(env)

    // Emit `init` early so the TUI can render the story list before any
    // Claude process spawns. Also emit `dag` so the DAG tab has something
    // to draw — without this it sits on "Waiting for DAG data…" forever.
    if (emitTui) {
        const prd = loadPrd(config.prdPath)
        emit({
            type: "init",
            project: prd.project,
            stories: prd.userStories.map((s) => ({
                id: s.id,
                title: s.title,
                depends_on: s.dependsOn,
            })),
        })
        const dagLevels = buildDag(prd.userStories).map((lvl) =>
            lvl.storyIds.map((id) => ({ id })),
        )
        emit({ type: "dag", levels: dagLevels })
    }

    // Mozaik-native: kick the run by emitting a RunStartRequestItem on
    // the bus. Conductor's onExternalBusEvent handler picks it up and drives
    // the state machine forward via further bus events. There is no
    // `conductor.run()` call — the runtime is the loop.
    env.deliverSemanticEvent(
        operator,
        RunStartRequest.create({ reason: "orchestrate" }),
    )
    const summary = await conductor.done

    // Drain detached fallback/non-worktree pushes before finishing.
    await Promise.allSettled(storyPushes)

    // Push the accumulated run branch once (worktree merge-backs only touched
    // the local branch during the run). Done after conductor.done so the slow
    // network push can't stall the run; before the Finalizer so its PR sees
    // every commit.
    if (worktreePushNeeded) {
        const log = (line: string) =>
            emitTui && emit({ type: "story_log", id: "_git", line })
        try {
            await gitPushWithRetry(gitGate, { cwd: config.cwd, onLog: log })
            if (emitTui) emit({ type: "push_status", id: "_git", success: true, error: null })
        } catch (e) {
            if (emitTui) emit({ type: "push_status", id: "_git", success: false, error: (e as Error)?.message ?? String(e) })
        }
    }

    // Backstop: per-story worktrees are removed as each story settles, but
    // sweep any stragglers + the temp dir + dangling branches here.
    await worktrees?.cleanupAll()

    // Drain in-flight async observers so all side effects (CritiqueItem,
    // ReplanItem) land in the audit log before this function returns.
    if (critic) await critic.idle()
    if (surgeon) await surgeon.idle()
    // Wait for Finalizer to open (or knowingly skip) the PR before we
    // emit the TUI `done` event, so the completion screen has the PR
    // URL the moment it renders instead of after a race.
    if (finalizer) await finalizer.complete()

    let filesCreated = 0
    let filesModified = 0
    if (useGit && baseSha) {
        const stats = await getGitFileStats(config.cwd, baseSha)
        filesCreated = stats.created
        filesModified = stats.modified
    }

    if (emitTui) {
        emit({
            type: "done",
            total_time_secs: summary.totalDurationSecs,
            success: summary.success,
            abort_reason: summary.abortReason ?? undefined,
            stats: {
                stories_completed: summary.completedStories.length,
                stories_skipped:
                    summary.failedStories.length + summary.droppedStories.length,
                total_commits: 0,
                files_created: filesCreated,
                files_modified: filesModified,
            },
        })
    }

    return {
        summary,
        operator,
        storyAgents: new Map(),
    }
}

/**
 * Pull a few keyword-shaped tokens out of free text for Librarian
 * relevance hints. Lowercased, alphanumeric runs ≥ 3 chars.
 */
function tokenizeForHints(text: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const match of text.toLowerCase().matchAll(/[a-z0-9_./-]{3,}/g)) {
        const tok = match[0]
        if (seen.has(tok)) continue
        seen.add(tok)
        out.push(tok)
    }
    return out
}
