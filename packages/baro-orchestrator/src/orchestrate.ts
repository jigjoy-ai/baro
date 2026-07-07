/**
 * High-level entry: build a Mozaik environment with all the standard
 * baro participants, run a PRD to completion, return a summary.
 *
 * Used by:
 *   - the Rust orchestrator client (via run-orchestrator.ts)
 *   - direct TS callers (tests, demos)
 */

import { mkdirSync } from "fs"
import { hostname } from "os"
import { dirname, join } from "path"

import { AgenticEnvironment } from "@mozaik-ai/core"

import {
    GitGate,
    createOrCheckoutBranch,
    excludeBaroArtifacts,
    getCurrentBranch,
    getDiff,
    getGitFileStats,
    getHeadSha,
    hasRemoteOrigin,
    isInsideGitRepo,
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
import { GitCoordinator } from "./participants/git-coordinator.js"
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
import { Supervisor } from "./participants/supervisor.js"
import { resolveEffectiveParallel } from "./planning/mode-enforcement.js"
import { PrdFile, loadPrd, savePrd } from "./prd.js"
import { RunStartRequest } from "./semantic-events.js"
import { emit } from "./tui-protocol.js"

export interface OrchestrateConfig {
    prdPath: string
    cwd: string
    parallel?: number
    timeoutSecs?: number
    overrideModel?: string | null
    defaultModel?: string
    /** Path for the audit JSONL log. If omitted, no Auditor joins. */
    auditLogPath?: string
    /** Emit BaroEvents to stdout for a TUI consumer. Default: true. */
    emitTuiEvents?: boolean
    /**
     * Perform git lifecycle operations (branch create, push, pull --rebase).
     * If undefined, auto-detected from whether `cwd` is a git working tree.
     */
    withGit?: boolean
    /**
     * `--continue`: stay on the CURRENT branch instead of creating a new one,
     * so the run lands on the existing PR and re-reads the prior work as
     * context.
     */
    continueRun?: boolean
    /**
     * Wire the Librarian (cross-agent runtime memory): later-level story
     * prompts get augmented with earlier stories' findings. Default: true.
     */
    withLibrarian?: boolean
    /**
     * Use semantic memory (MemoryLibrarian, ONNX embeddings + Vectra) instead
     * of the tag-based Librarian. Default: true (when withLibrarian is true);
     * false (`--no-memory`) falls back to tag-based.
     */
    withMemory?: boolean
    /**
     * Wire the Sentry: overlapping Edit/Write tool calls across agents emit
     * CoordinationItem warnings. Default: true.
     */
    withSentry?: boolean
    /**
     * Wire the Critic (live acceptance-criteria evaluator). Auth comes
     * through the CLI backend's existing config — no API key needed.
     * Default: false.
     */
    withCritic?: boolean
    /** Critic model. Default: "haiku" (any alias `claude --model` accepts). */
    criticModel?: string
    /**
     * Wire the Surgeon (adaptive DAG mutation): terminal story failures
     * trigger ReplanItems that Conductor applies at the next level boundary.
     * Default: false.
     */
    withSurgeon?: boolean
    /**
     * Wire the Supervisor: a story spinning without progress is aborted early
     * so it fails fast and the Surgeon can split/escalate it, instead of
     * burning the run budget on non-terminal retries. Default: false.
     */
    withSupervisor?: boolean
    /**
     * Use an LLM for Surgeon evaluation. Default false = deterministic
     * skip-only strategy; true costs tokens but allows richer replans
     * (split, insert prerequisite, rewire deps).
     */
    surgeonUseLlm?: boolean
    /** Model for the Surgeon LLM. Default: "opus". */
    surgeonModel?: string
    /**
     * Seconds between story spawns inside a DAG level. Default: 10;
     * 0 disables staggering.
     */
    intraLevelDelaySecs?: number
    /**
     * Run each story in its own git worktree. Default: true when git
     * lifecycle is on; false keeps the shared-tree behaviour.
     */
    withWorktrees?: boolean
    /**
     * Symlink dependency dirs (node_modules, …) from the repo root into each
     * story worktree so builds/tests resolve. Default: true.
     */
    worktreeLinkDepDirs?: boolean
    /**
     * Default backend for every Story/Critic/Surgeon phase unless a per-phase
     * override (`storyLlm`/`criticLlm`/`surgeonLlm`) is set. Architect +
     * Planner are routed by the Rust TUI layer — orchestrate.ts never sees
     * them.
     */
    llm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    /**
     * Per-phase overrides; win over `llm`. Used by the `--llm hybrid` preset
     * (Story+Critic on the cheap backend, Surgeon on the strong one).
     */
    storyLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    criticLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    surgeonLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    /**
     * StoryAgent model override (`--story-model`). Wins over each story's
     * own `model` field in the PRD as well as over the OpenAI default.
     */
    storyModel?: string
    /**
     * Passed as `claude --effort` (low|medium|high|xhigh|max). Only the
     * Claude backend honours it.
     */
    effort?: string
    /**
     * Tier→`backend:model` bindings (`--tier-map` / `BARO_TIER_MAP`): binds
     * the Planner's per-story blast-radius tier to a concrete backend+model.
     * Absent → per-story tiers resolve on the phase `llm`.
     */
    tierMap?: import("./routing.js").TierMap
    /**
     * Named OpenAI-compatible endpoints (`--openai-endpoint`). Routes of the
     * form `openai:model@name` resolve their base URL + key here, so one DAG
     * can hit several endpoints at once.
     */
    openaiEndpoints?: import("./routing.js").EndpointMap
    /**
     * Where story agents run. Default: in-process (`LocalStoryExecutor`);
     * pass a custom StoryExecutor (mock, out-of-process, remote) without
     * changing any other participant.
     */
    executor?: import("./participants/story-executor.js").StoryExecutor
    /** Hooks for receiving Operator commands externally (Rust TUI). */
    operatorHooks?: {
        onAbort?: (storyId: string) => void
        onAbortAll?: () => void
        onShutdown?: () => void
    }
    /**
     * Called once the Operator has joined the bus — the caller can then
     * dispatch external commands (TUI stdin lane) mid-run instead of
     * waiting for the OrchestrateResult.
     */
    onOperatorReady?: (operator: Operator) => void
    /** Extra participants to attach to the bus before the run starts. */
    extraParticipants?: import("@mozaik-ai/core").Participant[]
}

/**
 * Per-story timeout (seconds). `--timeout N` is an absolute override in both
 * directions (the Rust CLI sends 0 to mean "auto"). The auto default scales
 * by effort because max-effort stories routinely exceeded 600s and got
 * SIGTERM'd, wasting a full retry.
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
    // Set once at the chokepoint every run passes through; child agents
    // inherit process.env, so no shell command they issue can hang on a
    // prompt or a test watcher.
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
    // Downstream factories branch on these per-phase values, never on the
    // global `llm`.
    const storyLlm = config.storyLlm ?? llm
    const criticLlm = config.criticLlm ?? llm
    const surgeonLlm = config.surgeonLlm ?? llm

    // The Critic fires on AgentResult, which the pi/opencode STORY backends
    // never emit — so it stays silent regardless of which backend the Critic
    // itself runs on. Warn loudly rather than failing quietly.
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

    // Routing banner for stderr / audit log. Architect + Planner run as
    // separate Rust-TUI subprocesses and log their own banners.
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

    if (config.auditLogPath) {
        mkdirSync(dirname(config.auditLogPath), { recursive: true })
        new Auditor({ path: config.auditLogPath }).join(env)
    }

    if (config.extraParticipants) {
        for (const p of config.extraParticipants) p.join(env)
    }

    if (emitTui) {
        joinBaroEventForwarders(env)
    }

    const operator = new Operator(config.operatorHooks ?? {})
    operator.setEnvironment(env)
    operator.join(env)
    config.onOperatorReady?.(operator)

    const useGit = config.withGit ?? (await isInsideGitRepo(config.cwd))
    const gitGate = new GitGate()
    let baseSha: string | null = null

    // Continue mode: override prd.branchName with the checked-out branch so
    // createOrCheckoutBranch is a no-op and the Finalizer pushes here — `gh
    // pr create` then finds the open PR and updates it.
    if (config.continueRun && useGit) {
        const cur = await getCurrentBranch(config.cwd)
        if (cur) {
            const prd = loadPrd(config.prdPath)
            if (prd.branchName !== cur) {
                prd.branchName = cur
                savePrd(config.prdPath, prd)
            }
            process.stderr.write(`[orchestrate] continue mode — staying on branch '${cur}' (updates the existing PR)\n`)
        }
    }

    // Shared by the memory session path and worktree branch/dir names so
    // concurrent runs and resumes never collide.
    const runId = `run-${Date.now()}-${process.pid}`

    // BARO_NO_WORKTREES is NO_COLOR-style: ANY value, including empty,
    // disables worktrees (no Rust CLI flag plumbing needed).
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
    // Owns merge-back/push/cleanup and reports StoryMerged/StoryMergeFailed
    // on the bus. Non-worktree pushes run off the Conductor's critical path;
    // worktree merge-backs stay LOCAL and push once in finish() — a per-story
    // push would re-stall the Conductor, since it shares gitGate with the
    // merge-back.
    const gitCoordinator = useGit
        ? new GitCoordinator({
              cwd: config.cwd,
              gitGate,
              worktrees,
              emitTui,
          })
        : null
    if (gitCoordinator) gitCoordinator.join(env)

    const useLibrarian = config.withLibrarian ?? true
    const useSentry = config.withSentry ?? true
    const useMemory = config.withMemory ?? true

    // Session-scoped memory path (Vectra index + cache.json), shared
    // cross-process via BARO_MEMORY_PATH.
    const sessionsDir = join(process.env.HOME || "/tmp", ".baro", "sessions")
    const memorySessionPath = useMemory
        ? join(sessionsDir, runId, "memory")
        : undefined

    // Prune stale session dirs (>24h old) to prevent unbounded growth.
    if (useMemory) {
        try {
            const { pruneOldSessions } = await import("@baro/memory")
            pruneOldSessions(sessionsDir)
        } catch { /* non-critical */ }
    }

    if (memorySessionPath) {
        process.env.BARO_MEMORY_PATH = memorySessionPath
    }

    const librarian = useLibrarian
        ? (useMemory ? new MemoryLibrarian({ sessionPath: memorySessionPath }) : new Librarian())
        : null
    const sentry = useSentry ? new Sentry() : null
    if (librarian) librarian.join(env)
    if (sentry) sentry.join(env)

    // Surgeon joins early so it sees StoryResultItems from the moment the
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
        // Lets the Surgeon's replan reason name the model that actually ran
        // rather than the tier an override replaced. Only wired when an
        // override is in play — on a plain run the tier IS the model.
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
        // Stories default to the cheap model; the strong model is reached only
        // through this deliberate on-failure escalation, never the planner's
        // up-front tier. A global `--story-model` override wins over per-story
        // routes and would silently defeat it — so don't offer one then.
        const surgeonEscalationModel =
            config.surgeonModel ??
            (surgeonLlm === "openai" ? "gpt-5.5" : surgeonLlm === "claude" ? "opus" : undefined)
        const escalationRoute =
            surgeonEscalationModel && !config.storyModel
                ? `${surgeonLlm}:${surgeonEscalationModel}`
                : undefined
        // Bus contract is identical across providers, so observers never
        // notice the swap.
        if (surgeonLlm === "openai") {
            surgeon = new SurgeonOpenAI({
                snapshot,
                resolveRoute,
                escalationRoute,
                model: config.surgeonModel ?? "gpt-5.5",
            })
        } else if (surgeonLlm === "codex") {
            surgeon = new SurgeonCodex({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
            })
        } else if (surgeonLlm === "opencode") {
            surgeon = new SurgeonOpenCode({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
            })
        } else if (surgeonLlm === "pi") {
            surgeon = new SurgeonPi({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
            })
        } else {
            surgeon = new Surgeon({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? false,
                model: config.surgeonModel ?? "opus",
            })
        }
        surgeon.join(env)
    }

    let critic: Critic | CriticOpenAI | CriticCodex | CriticOpenCode | CriticPi | null = null
    if (config.withCritic) {
        const prd = loadPrd(config.prdPath)
        const targets = new Map<string, readonly string[]>(
            prd.userStories
                .filter((s) => s.acceptance && s.acceptance.length > 0)
                .map((s) => [s.id, s.acceptance] as [string, readonly string[]]),
        )
        // Bus contract is identical across providers, so observers never
        // notice the swap.
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

    // Finalizer only joins on git runs WITH an origin remote — a preview
    // (diffOnly) or local-only run has none, and running `gh pr create`/push
    // there just produces noisy failures. `gh` availability is checked inside.
    const hasOrigin = useGit ? await hasRemoteOrigin(config.cwd) : false
    if (useGit && !hasOrigin) {
        process.stderr.write("[orchestrate] no origin remote — skipping push/PR (preview/local run)\n")
    }
    const finalizer = useGit && hasOrigin
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

    // Parallelism follows the DAG. Stories the planner placed in the same level
    // are independent by construction, so they run in parallel up to the operator
    // cap (config.parallel; 0 = unlimited, hosted sends ~10). Only a DELIBERATE
    // choice serializes: `focused` (a single-fix mode), or a USER-picked
    // `sequential` (caution the DAG can't see). Intake's coarse AUTO "sequential"
    // guess (source llm/heuristic) must NOT override the planner's DAG — that was
    // the bug where a parallel DAG ran one story at a time.
    const executionMode = loadPrd(config.prdPath).executionMode
    const effectiveParallel = resolveEffectiveParallel(executionMode, config.parallel)
    if (executionMode) {
        process.stderr.write(
            `[orchestrate] execution mode: ${executionMode.mode} (${executionMode.source ?? "contract"}) — parallel cap ${effectiveParallel === 0 ? "none" : effectiveParallel}\n`,
        )
    }

    const conductor = new Conductor({
        prdPath: config.prdPath,
        cwd: config.cwd,
        parallel: effectiveParallel,
        timeoutSecs: storyTimeoutSecs(config.timeoutSecs, config.effort),
        overrideModel: config.overrideModel ?? undefined,
        defaultModel: config.defaultModel ?? "opus",
        intraLevelDelaySecs: config.intraLevelDelaySecs,
        onRunStart: useGit
            ? async (prd) => {
                  baseSha = await getHeadSha(config.cwd)
                  await excludeBaroArtifacts(config.cwd)
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
                  const hints: string[] = [
                      ...tokenizeForHints(story.title),
                      ...tokenizeForHints(story.description).slice(0, 8),
                  ]
                  return librarian.gatherContext(storyId, hints)
              }
            : undefined,
        onStoryPassed: gitCoordinator
            ? (storyId) => gitCoordinator.onStoryPassed(storyId)
            : undefined,
        onStoryFailed: worktrees && gitCoordinator
            ? (storyId) => gitCoordinator.onStoryFailed(storyId)
            : undefined,
    })
    conductor.setEnvironment(env)
    conductor.join(env)

    // Spawns StoryAgents in response to StorySpawnRequests from Conductor,
    // dispatching per-spawn on the resolved backend.
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

    // Emits StoryIntervention(abort) for a spinning story so it settles as a
    // failed StoryResult the Surgeon can split/escalate, instead of burning
    // the run budget. StoryFactory consumes the event off the bus.
    if (config.withSupervisor) {
        new Supervisor().join(env)
    }

    // Emit `init` + `dag` before any agent spawns — without `dag` the TUI's
    // DAG tab sits on "Waiting for DAG data…" forever.
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
            runner: hostname(),
            mode: prd.executionMode?.mode,
            mode_reason: prd.executionMode?.reason,
        })
        const dagLevels = buildDag(prd.userStories).map((lvl) =>
            lvl.storyIds.map((id) => ({ id })),
        )
        emit({ type: "dag", levels: dagLevels })
        // The Architect's decision spec otherwise lives only in prd.json.
        if (prd.decisionDocument && prd.decisionDocument.trim()) {
            emit({ type: "decision_document", document: prd.decisionDocument })
        }
    }

    // There is no `conductor.run()` call — the bus runtime is the loop.
    env.deliverSemanticEvent(
        operator,
        RunStartRequest.create({ reason: "orchestrate" }),
    )
    const summary = await conductor.done

    // Drain detached pushes + the single worktree merge-back push: after
    // conductor.done so the network can't stall the run, before the
    // Finalizer so its PR sees every commit.
    if (gitCoordinator) await gitCoordinator.finish()

    // Backstop sweep for straggler worktrees + temp dir + dangling branches.
    await worktrees?.cleanupAll()

    // Drain in-flight async observers so their side effects land in the
    // audit log before this function returns.
    if (critic) await critic.idle()
    if (surgeon) await surgeon.idle()
    // Await the PR before the TUI `done` event so the completion screen has
    // the PR URL the moment it renders instead of after a race.
    if (finalizer) await finalizer.complete()

    let filesCreated = 0
    let filesModified = 0
    if (useGit && baseSha) {
        const stats = await getGitFileStats(config.cwd, baseSha)
        filesCreated = stats.created
        filesModified = stats.modified

        // Full run diff as a safety net for the Changes view (per-story diffs
        // can be missed on the shared-tree fallback). The TUI dedupes files
        // by path, so this is harmless when they already landed.
        if (emitTui) {
            const runDiff = await getDiff(config.cwd, baseSha, "HEAD")
            if (runDiff.files.length) {
                emit({
                    type: "story_diff",
                    id: "(run)",
                    files: runDiff.files,
                    diff: runDiff.diff || undefined,
                })
            }
        }
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

/** Keyword-shaped tokens for Librarian relevance hints. */
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
