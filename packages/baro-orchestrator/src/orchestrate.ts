/**
 * High-level entry: build a Mozaik environment with all the standard
 * baro participants, run a PRD to completion, return a summary.
 *
 * Used by:
 *   - the Rust orchestrator client (via run-orchestrator.ts)
 *   - direct TS callers (tests, demos)
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { homedir, hostname, tmpdir } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

import { AgenticEnvironment } from "@mozaik-ai/core"

import {
    GatewayBillingCoordinator,
    type GatewayBillingCoordinatorOptions,
} from "./billing/index.js"
import {
    GitGate,
    createOrCheckoutBranch,
    excludeBaroArtifacts,
    getCommitCount,
    getCurrentBranch,
    getDiff,
    getGitFileStats,
    getHeadSha,
    hasRemoteOrigin,
    isInsideGitRepo,
} from "./git.js"
import { WorktreeManager } from "./worktree.js"
import { StoryOutcomeAuthority } from "./runtime/story-outcome-authority.js"
import { buildDag } from "./dag.js"
import {
    canonicalTier,
    formatRoute,
    resolveStoryRoute,
    type ResolveOpts,
    type TierMap,
} from "./routing.js"
import { Auditor } from "./participants/auditor.js"
import { AcceptanceGate } from "./participants/acceptance-gate.js"
import { AgentTurnProjector } from "./participants/agent-turn-projector.js"
import { CollaborationBridge } from "./participants/collaboration-bridge.js"
import { CollectiveBoard } from "./participants/collective-board.js"
import {
    Conductor,
    ConductorRunSummary,
} from "./participants/conductor.js"
import { Critic } from "./participants/critic.js"
import {
    CriticCommandEvidenceCollector,
    type CriticRepositoryTarget,
    type CriticEvidenceSource,
} from "./participants/critic-evidence.js"
import { CriticTargetRegistry } from "./participants/critic-target-registry.js"
import { CriticCodex } from "./participants/critic-codex.js"
import { CriticOpenAI } from "./participants/critic-openai.js"
import { CriticOpenCode } from "./participants/critic-opencode.js"
import { CriticPi } from "./participants/critic-pi.js"
import {
    DialogueAgent,
    type DialogueResponder,
} from "./participants/dialogue-agent.js"
import {
    createDialogueResponder,
    type DialogueBackend,
} from "./participants/dialogue-responder.js"
import { Finalizer } from "./participants/finalizer.js"
import { GitCoordinator } from "./participants/git-coordinator.js"
import { DialogueForwarder } from "./participants/forwarders/dialogue.js"
import { joinBaroEventForwarders } from "./participants/forwarders/index.js"
import { Librarian } from "./participants/librarian.js"
import { LeaseBroker } from "./participants/lease-broker.js"
import { LocalRepositoryAgent } from "./participants/local-repository-agent.js"
import { MemoryLibrarian } from "./participants/memory-librarian.js"
import { ModelTelemetryCollector } from "./participants/model-telemetry-collector.js"
import { Operator } from "./participants/operator.js"
import { PlanningFeed } from "./participants/planning-feed.js"
import { RunVerifier } from "./participants/run-verifier.js"
import { Sentry } from "./participants/sentry.js"
import { StoryFactory } from "./participants/story-factory.js"
import { WorkContextProvider } from "./participants/work-context-provider.js"
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
import {
    ModelInvocationMeasured,
    RunStartRequest,
    type CoordinationMode,
    type WorkBidEstimateData,
} from "./semantic-events.js"
import { emit } from "./tui-protocol.js"
import { createVerifyPlan, recommendedVerifyTimeoutMs } from "./verify.js"
import {
    assertConversationContextBinding,
    validateConversationContextSnapshot,
    type ConversationContextSnapshot,
} from "./session/conversation-context.js"
import {
    isValidWorkBidEstimate,
    selectWorkBid,
    type WorkBidPolicy,
} from "./work-market.js"

export interface CollectiveWorkerCandidateConfig {
    workerId: string
    routeId: string
    /** Existing backend:model@endpoint route syntax. */
    route: string
    tiers?: readonly string[]
    maxConcurrent?: number
    estimate: WorkBidEstimateData
}

type CriticLifecycle = { idle(): Promise<void> }
type StoryWorktreeTarget = Pick<WorktreeManager, "activePath" | "creationSha">

/**
 * Story evidence is attributable only while its isolated worktree remains
 * active. The shared run tree can contain sibling/run-wide changes and must
 * never be credited to one story.
 */
export function resolveCriticRepositoryTarget(
    worktrees: StoryWorktreeTarget | null,
    storyId: string,
): CriticRepositoryTarget | null {
    const cwd = worktrees?.activePath(storyId) ?? null
    if (!cwd) return null
    return {
        cwd,
        baseSha: worktrees?.creationSha(storyId) ?? null,
    }
}

/** Do not mutate/release story repositories while Critic reads evidence. */
export async function withCriticEvidenceBarrier<T>(
    critic: CriticLifecycle | null,
    mutateRepository: () => Promise<T>,
): Promise<T> {
    if (critic) await critic.idle()
    return mutateRepository()
}

export interface OrchestrateConfig {
    prdPath: string
    cwd: string
    /** Stable authority/correlation identity shared with planning and billing. */
    runId?: string
    parallel?: number
    timeoutSecs?: number
    /** Coordination engine. `legacy` remains the default. */
    coordinationMode?: CoordinationMode
    /** Allow push and PR creation. False keeps the complete git lifecycle local. */
    publishRemote?: boolean
    /** Optional collective execution-lease watchdog; disabled by default. */
    collectiveLeaseTimeoutMs?: number
    /** Explicit trusted Baro Gateway receipt feed. Arbitrary compatible
     * endpoints never become billing authorities implicitly. */
    gatewayBilling?: GatewayBillingConfig
    /** Optional collective repository-integration watchdog. */
    collectiveIntegrationTimeoutMs?: number
    /** Optional whole-run objective verification watchdog. */
    collectiveVerificationTimeoutMs?: number
    /** Optional per-story Critic evidence watchdog. Default: 240 seconds. */
    collectiveAcceptanceTimeoutMs?: number
    /** Bounded same-candidate Critic rechecks after an inconclusive verdict.
     * Default: 2. No implementation worker is launched by these rechecks. */
    collectiveAcceptanceReverificationAttempts?: number
    /** Optional communication-only conversational participant. Collective only. */
    withDialogue?: boolean
    /** Text-only backing model for DialogueAgent. Defaults to a compatible run backend. */
    dialogueLlm?: DialogueBackend
    /** Provider model for DialogueAgent. Defaults by backend. */
    dialogueModel?: string
    /** Per-user-message response timeout. Default: 60 seconds. */
    dialogueTimeoutMs?: number
    /** Test/embedding seam; overrides the built-in text-only model adapter. */
    dialogueResponder?: DialogueResponder
    /** Ephemeral front-door continuity for DialogueAgent. It is strictly
     * bound to PRD conversation metadata and is never persisted to the repo. */
    conversationContext?: ConversationContextSnapshot
    /** Opt-in autonomous worker candidates; absent preserves first-claim collective. */
    collectiveWorkers?: readonly CollectiveWorkerCandidateConfig[]
    /** Bounded local auction window. Default: 50ms when candidates are configured. */
    collectiveBidWindowMs?: number
    /** Safety/cost constraints applied before deterministic bid ranking. */
    collectiveBidPolicy?: WorkBidPolicy
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
     * (Story on the alternate backend; Critic/Surgeon may stay tool-less).
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
    /** Called after the optional DialogueAgent has joined the same bus. */
    onDialogueReady?: (dialogue: DialogueAgent) => void
    /** Opt-in, collective-only Planner stream identity. Omit to preserve the
     * existing full-plan startup barrier exactly. */
    progressivePlanningId?: string
    /** Called only after the Board has opened/persisted the planning latch. */
    onPlanningFeedReady?: (feed: PlanningFeed) => void
    /** Extra participants to attach to the bus before the run starts. */
    extraParticipants?: import("@mozaik-ai/core").Participant[]
}

export function resolveOrchestrationRunId(
    configured: string | undefined,
    inherited: string | undefined,
    fallback: () => string = () => `run-${Date.now()}-${process.pid}`,
): string {
    const requested = configured ?? inherited
    if (
        requested !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requested)
    ) {
        throw new Error("runId/BARO_RUN_ID must be a safe 1-128 character identifier")
    }
    return requested ?? fallback()
}

export type GatewayBillingConfig = Omit<
    GatewayBillingCoordinatorOptions,
    "runId" | "publishMeasurement"
>

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
    /**
     * @deprecated A completed orchestration has no active workers. Retained for
     * source compatibility and returned empty; use Operator/events mid-run.
     */
    storyAgents: Map<string, StoryAgent>
}

/**
 * Build, run, and tear down the orchestration environment for a single
 * PRD execution.
 */
export async function orchestrate(
    config: OrchestrateConfig,
): Promise<OrchestrateResult> {
    const conversationContext = config.conversationContext
        ? validateConversationContextSnapshot(config.conversationContext)
        : undefined
    if (conversationContext) {
        const prd = loadPrd(config.prdPath)
        assertConversationContextBinding(conversationContext, prd)
    }
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
    const coordinationMode = config.coordinationMode ?? "legacy"
    const publishRemote = config.publishRemote ?? true
    const llm: "claude" | "openai" | "codex" | "opencode" | "pi" = config.llm ?? "claude"
    // Downstream factories branch on these per-phase values, never on the
    // global `llm`.
    const storyLlm = config.storyLlm ?? llm
    const criticLlm = config.criticLlm ?? llm
    const surgeonLlm = config.surgeonLlm ?? llm
    const collectiveWorkers = [...(config.collectiveWorkers ?? [])]
    validateCollectiveWorkers(
        collectiveWorkers,
        coordinationMode,
        config.storyModel,
    )
    validateCollectiveMarketOptions(
        collectiveWorkers.length,
        coordinationMode,
        config.collectiveBidWindowMs,
        config.collectiveBidPolicy,
    )
    const defaultStorySelector = resolveDefaultStorySelector({
        configured: config.defaultModel,
        tierMap: config.tierMap,
        collectiveWorkerCount: collectiveWorkers.length,
    })
    if (config.withDialogue && coordinationMode !== "collective") {
        throw new Error("DialogueAgent requires coordinationMode='collective'")
    }
    if (config.progressivePlanningId && coordinationMode !== "collective") {
        throw new Error(
            "progressive planning requires coordinationMode='collective'",
        )
    }
    if (conversationContext && !config.withDialogue) {
        throw new Error("conversationContext requires DialogueAgent")
    }

    // Shared by event correlation, memory sessions, and worktree names.
    // It is created before Operator so user conversation events carry the
    // same identity as the collective control plane from their first hop.
    const runId = resolveOrchestrationRunId(config.runId, process.env.BARO_RUN_ID)
    const outcomeAuthority = coordinationMode === "collective"
        ? new StoryOutcomeAuthority(runId)
        : undefined

    process.stderr.write(
        `[orchestrate] coordination=${coordinationMode}` +
            (publishRemote ? "" : " (local-only; push/PR disabled)") +
            "\n",
    )

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
            .map(([name, ep]) => `${name}→configured${ep.apiKey ? "" : " (no key!)"}`)
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

    const dagForwarder = emitTui ? joinBaroEventForwarders(env) : null

    const operator = new Operator(
        config.operatorHooks ?? {},
        { runId },
    )
    operator.setEnvironment(env)
    operator.join(env)

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

    // Always-on semantic telemetry; unlike stdout/TUI forwarders this remains
    // present in headless tests and local programmatic orchestration.
    const modelTelemetryCollector = new ModelTelemetryCollector({
        runId,
        outcomeAuthority,
    })
    modelTelemetryCollector.join(env)
    const gatewayBillingCoordinator = config.gatewayBilling
        ? new GatewayBillingCoordinator({
              ...config.gatewayBilling,
              runId,
              publishMeasurement: (measurement) => {
                  if (
                      measurement.phase === "story" &&
                      measurement.evidence.producer === "runner"
                  ) {
                      modelTelemetryCollector.registerPerRoundStoryMeasurement(
                          measurement,
                      )
                  }
                  env.deliverSemanticEvent(
                      modelTelemetryCollector,
                      ModelInvocationMeasured.create(measurement),
                  )
              },
          })
        : null
    let gatewayBillingReconciled = false
    let dialogueRuntimeCwd: string | null = null
    let cleanupDialogue: (() => void) | null = null
    const reconcileGatewayBilling = async (): Promise<void> => {
        if (!gatewayBillingCoordinator || gatewayBillingReconciled) return
        gatewayBillingReconciled = true
        try {
            const billing = await gatewayBillingCoordinator.drain()
            if (!billing.complete) {
                process.stderr.write(
                    `[billing] ${billing.unresolvedInvocationIds.length} invocation(s) ` +
                        `remain without acknowledged authoritative telemetry` +
                        (billing.feedError ? ` (${billing.feedError})` : "") +
                        "\n",
                )
            }
        } catch (error) {
            process.stderr.write(
                `[billing] reconciliation failed (${error instanceof Error ? error.message : "unknown error"})\n`,
            )
        } finally {
            gatewayBillingCoordinator.close()
        }
    }

    try {
    // Codex/OpenCode/Pi expose terminal turns through different native events.
    // Project them onto one neutral contract so policy participants such as the
    // Critic depend on semantics rather than a provider-specific stream shape.
    const agentTurnProjector = new AgentTurnProjector({ outcomeAuthority })
    agentTurnProjector.join(env)
    const hasOrigin = useGit ? await hasRemoteOrigin(config.cwd) : false
    const pushRemote = publishRemote && hasOrigin

    // BARO_NO_WORKTREES is NO_COLOR-style: ANY value, including empty,
    // disables worktrees (no Rust CLI flag plumbing needed).
    const worktreesEnabled =
        config.withWorktrees ?? !("BARO_NO_WORKTREES" in process.env)
    if (coordinationMode === "collective" && useGit && !worktreesEnabled) {
        throw new Error(
            "collective coordination requires isolated git worktrees; unset BARO_NO_WORKTREES or use legacy coordination",
        )
    }
    const worktrees =
        useGit && worktreesEnabled
            ? new WorktreeManager(config.cwd, gitGate, runId, {
                  linkDepDirs: config.worktreeLinkDepDirs ?? true,
                  allowSharedFallback: coordinationMode === "legacy",
                  resolveConflictsWithTheirs: coordinationMode === "legacy",
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
              eventDriven: coordinationMode === "collective",
              runId,
              prdPath: config.prdPath,
              push: pushRemote,
          })
        : null
    if (gitCoordinator) gitCoordinator.join(env)
    const localRepositoryAgent =
        !gitCoordinator && coordinationMode === "collective"
            ? new LocalRepositoryAgent(runId)
            : null
    localRepositoryAgent?.join(env)
    const repositoryAuthority = gitCoordinator ?? localRepositoryAgent
    if (repositoryAuthority) {
        dagForwarder?.setRepositoryAuthority(repositoryAuthority)
    }

    const useLibrarian = config.withLibrarian ?? true
    const useSentry = config.withSentry ?? true
    const useMemory = config.withMemory ?? true

    // Session-scoped memory path (Vectra index + cache.json), shared
    // cross-process via BARO_MEMORY_PATH.
    const sessionsDir = join(homedir(), ".baro", "sessions")
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

    const workContextProvider = coordinationMode === "collective"
        ? new WorkContextProvider(runId, librarian)
        : null
    workContextProvider?.join(env)

    const bundledCollaborationCommand = fileURLToPath(
        new URL("./agent-collab.mjs", import.meta.url),
    )
    const developmentCollaborationCommand = fileURLToPath(
        new URL("../scripts/agent-collab.mjs", import.meta.url),
    )
    const collaborationConfig = coordinationMode === "collective"
        ? {
              commandPath: existsSync(bundledCollaborationCommand)
                  ? bundledCollaborationCommand
                  : developmentCollaborationCommand,
              sessionDir: join(sessionsDir, runId, "collective"),
          }
        : undefined
    const collaborationBridge = collaborationConfig
        ? new CollaborationBridge({
              runId,
              sessionDir: collaborationConfig.sessionDir,
          })
        : null
    if (collaborationBridge) {
        workContextProvider?.setCollaborationAuthority(collaborationBridge)
    }
    collaborationBridge?.join(env)

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
        // The model reasoning ABOUT recovery is not necessarily the model
        // executing replacement work. With a tier map/worker market, keep the
        // replacement semantic (`heavy`) so normal routing and bidding select
        // the configured strong executor. Without tier routing, preserve the
        // historical explicit Surgeon-backend escalation.
        const escalationRoute = resolveSurgeonEscalationRoute({
            surgeonLlm,
            surgeonModel: config.surgeonModel,
            storyModel: config.storyModel,
            tierMap: config.tierMap,
            collectiveWorkers,
        })
        // Bus contract is identical across providers, so observers never
        // notice the swap.
        if (surgeonLlm === "openai") {
            surgeon = new SurgeonOpenAI({
                snapshot,
                resolveRoute,
                escalationRoute,
                model: config.surgeonModel ?? "gpt-5.5",
                runId,
                emitRecoveryDecisions: coordinationMode === "collective",
                outcomeAuthority,
                billingCoordinator: gatewayBillingCoordinator ?? undefined,
            })
        } else if (surgeonLlm === "codex") {
            surgeon = new SurgeonCodex({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
                runId,
                emitRecoveryDecisions: coordinationMode === "collective",
                outcomeAuthority,
            })
        } else if (surgeonLlm === "opencode") {
            surgeon = new SurgeonOpenCode({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
                runId,
                emitRecoveryDecisions: coordinationMode === "collective",
                outcomeAuthority,
            })
        } else if (surgeonLlm === "pi") {
            surgeon = new SurgeonPi({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? true,
                model: config.surgeonModel,
                runId,
                emitRecoveryDecisions: coordinationMode === "collective",
                outcomeAuthority,
            })
        } else {
            surgeon = new Surgeon({
                snapshot,
                resolveRoute,
                escalationRoute,
                useLlm: config.surgeonUseLlm ?? false,
                model: config.surgeonModel ?? "opus",
                runId,
                emitRecoveryDecisions: coordinationMode === "collective",
                outcomeAuthority,
            })
        }
        surgeon.join(env)
    }

    let critic: Critic | CriticOpenAI | CriticCodex | CriticOpenCode | CriticPi | null = null
    let criticTargetRegistry: CriticTargetRegistry | null = null
    let criticTargets = new Map<string, readonly string[]>()
    if (config.withCritic) {
        const resolveCriticTarget = (storyId: string) =>
            resolveCriticRepositoryTarget(worktrees, storyId)
        const commandEvidence = new CriticCommandEvidenceCollector({
            outcomeAuthority,
            resolveRepositoryTarget: resolveCriticTarget,
        })
        commandEvidence.join(env)
        const criticEvidence: CriticEvidenceSource = {
            resolveRepositoryTarget: resolveCriticTarget,
            commandEvidence: (storyId) =>
                commandEvidence.snapshotForEvaluation(storyId),
        }
        const prd = loadPrd(config.prdPath)
        criticTargets = new Map<string, readonly string[]>(
            prd.userStories
                .filter((s) => s.acceptance && s.acceptance.length > 0)
                .map((s) => [s.id, s.acceptance] as [string, readonly string[]]),
        )
        criticTargetRegistry = new CriticTargetRegistry(criticTargets)
        criticTargetRegistry.join(env)
        // Bus contract is identical across providers, so observers never
        // notice the swap.
        if (criticLlm === "openai") {
            critic = new CriticOpenAI({
                targets: criticTargets,
                model: config.criticModel ?? "gpt-5.4-mini",
                runId,
                evidence: criticEvidence,
                outcomeAuthority,
                terminalProjectorAuthority: agentTurnProjector,
                billingCoordinator: gatewayBillingCoordinator ?? undefined,
            })
        } else if (criticLlm === "codex") {
            critic = new CriticCodex({
                targets: criticTargets,
                model: config.criticModel,
                runId,
                evidence: criticEvidence,
                outcomeAuthority,
                terminalProjectorAuthority: agentTurnProjector,
            })
        } else if (criticLlm === "opencode") {
            critic = new CriticOpenCode({
                targets: criticTargets,
                model: config.criticModel,
                runId,
                evidence: criticEvidence,
                outcomeAuthority,
                terminalProjectorAuthority: agentTurnProjector,
            })
        } else if (criticLlm === "pi") {
            critic = new CriticPi({
                targets: criticTargets,
                model: config.criticModel,
                runId,
                evidence: criticEvidence,
                outcomeAuthority,
                terminalProjectorAuthority: agentTurnProjector,
            })
        } else {
            critic = new Critic({
                targets: criticTargets,
                model: config.criticModel ?? "haiku",
                runId,
                evidence: criticEvidence,
                outcomeAuthority,
                terminalProjectorAuthority: agentTurnProjector,
            })
        }
        critic.join(env)
    }

    // Finalizer only joins on git runs WITH an origin remote — a preview
    // (diffOnly) or local-only run has none, and running `gh pr create`/push
    // there just produces noisy failures. `gh` availability is checked inside.
    if (useGit && !hasOrigin) {
        process.stderr.write("[orchestrate] no origin remote — skipping push/PR (preview/local run)\n")
    }
    if (useGit && hasOrigin && !publishRemote) {
        process.stderr.write("[orchestrate] local-only mode — skipping push/PR\n")
    }
    const finalizer = useGit && hasOrigin && publishRemote
        ? new Finalizer({
              cwd: config.cwd,
              prdPath: config.prdPath,
              runId,
              outcomeAuthority,
              onLog: (line) =>
                  emitTui && emit({ type: "story_log", id: "_finalizer", line }),
          })
        : null
    if (finalizer) {
        if (repositoryAuthority) {
            finalizer.setRepositoryAuthority(repositoryAuthority)
        }
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

    let coordinationDone: Promise<ConductorRunSummary>
    let runVerifier: RunVerifier | null = null
    let leaseBroker: LeaseBroker | null = null
    let acceptanceGate: AcceptanceGate | null = null
    let dialogueAgent: DialogueAgent | null = null
    let planningFeed: PlanningFeed | null = null
    let collectiveBoard: CollectiveBoard | null = null
    if (coordinationMode === "legacy") {
        const conductor = new Conductor({
            prdPath: config.prdPath,
            cwd: config.cwd,
            parallel: effectiveParallel,
            timeoutSecs: storyTimeoutSecs(config.timeoutSecs, config.effort),
            overrideModel: config.overrideModel ?? undefined,
            defaultModel: defaultStorySelector,
            intraLevelDelaySecs: config.intraLevelDelaySecs,
            onRunStart: useGit
                ? async (prd) => {
                      await excludeBaroArtifacts(config.cwd)
                      if (prd.branchName) {
                          await createOrCheckoutBranch(
                              config.cwd,
                              prd.branchName,
                              (line) => emitTui && emit({ type: "story_log", id: "_git", line }),
                              pushRemote,
                          )
                      }
                      baseSha = await getHeadSha(config.cwd)
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
                ? (storyId) =>
                      withCriticEvidenceBarrier(critic, () =>
                          gitCoordinator.onStoryPassed(storyId),
                      )
                : undefined,
            onStoryFailed: worktrees && gitCoordinator
                ? (storyId) =>
                      withCriticEvidenceBarrier(critic, () =>
                          gitCoordinator.onStoryFailed(storyId),
                      )
                : undefined,
        })
        conductor.setEnvironment(env)
        conductor.join(env)
        // ReplanApplied is committed graph state, not an ambient bus claim.
        // Only this concrete Conductor may update legacy TUI/critic projections.
        criticTargetRegistry?.setLegacyReplanAuthority(conductor)
        dagForwarder?.setLegacyReplanAuthority(conductor)
        finalizer?.setCoordinationAuthority(conductor)
        coordinationDone = conductor.done
    } else {
        if (config.progressivePlanningId) {
            planningFeed = new PlanningFeed()
        }
        const collectiveParallel = useGit ? effectiveParallel : 1
        if (!repositoryAuthority) {
            throw new Error("collective coordination requires a repository authority")
        }
        if (!useGit && effectiveParallel !== 1) {
            process.stderr.write(
                "[orchestrate] collective non-git run is serialized because isolated worktrees are unavailable\n",
            )
        }
        const verifyPlan = createVerifyPlan(config.cwd)
        runVerifier = new RunVerifier({
            runId,
            cwd: config.cwd,
            plan: verifyPlan,
        })
        finalizer?.setVerifierAuthority(runVerifier)
        runVerifier.join(env)
        leaseBroker = new LeaseBroker({
            runId,
            parallel: collectiveParallel,
            intraLevelDelaySecs: config.intraLevelDelaySecs ?? 10,
            leaseTimeoutMs: config.collectiveLeaseTimeoutMs,
            integrationTimeoutMs: config.collectiveIntegrationTimeoutMs,
            outcomeAuthority,
            ...(collectiveWorkers.length > 0
                ? {
                      market: {
                          bidWindowMs: config.collectiveBidWindowMs ?? 50,
                          policy: config.collectiveBidPolicy,
                      },
                  }
                : {}),
        })
        leaseBroker.setIntegrationAuthority(repositoryAuthority)
        acceptanceGate = config.withCritic && critic
            ? new AcceptanceGate({
                  runId,
                  targets: criticTargets,
                  timeoutMs: config.collectiveAcceptanceTimeoutMs,
                  maxReverificationAttempts:
                      config.collectiveAcceptanceReverificationAttempts,
                  leaseAuthority: leaseBroker,
                  critiqueAuthority: critic,
                  outcomeAuthority,
                  terminalProjectorAuthority: agentTurnProjector,
              })
            : null
        agentTurnProjector.setLeaseAuthority(leaseBroker)
        if (acceptanceGate) {
            agentTurnProjector.setReverificationAuthority(acceptanceGate)
        }
        if (acceptanceGate) leaseBroker.setQualityAuthority(acceptanceGate)
        const board = collectiveBoard = new CollectiveBoard({
            runId,
            prdPath: config.prdPath,
            cwd: config.cwd,
            timeoutSecs: storyTimeoutSecs(config.timeoutSecs, config.effort),
            overrideModel: config.overrideModel ?? undefined,
            defaultModel: defaultStorySelector,
            expectRecoveryDecisions: config.withSurgeon ?? false,
            marketRouteIds: collectiveWorkers.map((worker) => worker.routeId),
            expectQualityDecisions: acceptanceGate !== null,
            leaseAuthority: leaseBroker,
            startAuthority: operator,
            qualityAuthority: acceptanceGate ?? undefined,
            integrationAuthority: repositoryAuthority,
            verifierAuthority: runVerifier,
            recoveryAuthority: surgeon ?? undefined,
            discoveryAuthority: collaborationBridge ?? undefined,
            runtimeReplanAuthority: collaborationBridge ?? undefined,
            progressivePlanningId: config.progressivePlanningId,
            planningAuthority: planningFeed ?? undefined,
            contextAuthority: workContextProvider ?? undefined,
            outcomeAuthority,
            verifyBeforePush: true,
            verificationTimeoutMs:
                config.collectiveVerificationTimeoutMs ??
                Math.max(
                    recommendedVerifyTimeoutMs(verifyPlan),
                    // The final integrated snapshot may introduce its first
                    // build/test scripts after this baseline was captured.
                    21 * 60_000,
                ),
        })
        runVerifier.setRequestAuthority(board)
        acceptanceGate?.setCompletionAuthority(board)
        finalizer?.setCoordinationAuthority(board)
        leaseBroker.setOfferAuthority(board)
        gitCoordinator?.setEventAuthority(board)
        gitCoordinator?.setLeaseAuthority(leaseBroker)
        localRepositoryAgent?.setRequestAuthority(board)
        workContextProvider?.setRequestAuthority(board)
        collaborationBridge?.setLeaseAuthority(leaseBroker)
        collaborationBridge?.setDecisionAuthority(board)
        criticTargetRegistry?.setRuntimeReplanAuthority(board)
        dagForwarder?.setRuntimeReplanAuthority(board)
        surgeon?.setLeaseAuthority(leaseBroker)
        if (acceptanceGate) surgeon?.setQualityAuthority(acceptanceGate)
        leaseBroker.join(env)
        board.join(env)
        planningFeed?.join(env)
        acceptanceGate?.join(env)
        coordinationDone = board.done
    }

    // Join workers after the coordinator/projector so nested executor events
    // are ordered behind the lease that authorized them.
    const factoryBase = {
        cwd: config.cwd,
        coordinationMode,
        runId,
        worktrees: worktrees ?? undefined,
        requireWorktree: coordinationMode === "collective" && worktrees !== null,
        collaboration: collaborationConfig,
        leaseAuthority: leaseBroker ?? undefined,
        offerAuthority: collectiveBoard ?? undefined,
        llm: storyLlm,
        openaiModel: config.storyModel ?? "gpt-5.5",
        storyModelOverride: config.storyModel,
        effort: config.effort,
        tierMap: config.tierMap,
        endpoints: config.openaiEndpoints,
        defaultApiKey: process.env.OPENAI_API_KEY,
        executor: config.executor,
        outcomeAuthority,
        runtimeReplanDecisionAuthority: collectiveBoard ?? undefined,
        turnReviewAuthority:
            coordinationMode === "collective" ? critic ?? undefined : undefined,
        acceptanceGateAuthority:
            coordinationMode === "collective"
                ? acceptanceGate ?? undefined
                : undefined,
        turnReviewTimeoutMs: config.collectiveAcceptanceTimeoutMs,
        telemetryAuthority: modelTelemetryCollector,
        billingCoordinator: gatewayBillingCoordinator ?? undefined,
    } as const
    const storyFactories = collectiveWorkers.length > 0
        ? collectiveWorkers.map(
              (candidate) =>
                  new StoryFactory({
                      ...factoryBase,
                      workerId: candidate.workerId,
                      bid: {
                          routeId: candidate.routeId,
                          route: candidate.route,
                          tiers: candidate.tiers,
                          maxConcurrent: candidate.maxConcurrent,
                          estimate: candidate.estimate,
                      },
                  }),
          )
        : [new StoryFactory(factoryBase)]
    for (const storyFactory of storyFactories) {
        storyFactory.setEnvironment(env)
        storyFactory.join(env)
    }

    // Emits StoryIntervention(abort) for a spinning story so it settles as a
    // failed StoryResult the Surgeon can split/escalate, instead of burning
    // the run budget. StoryFactory consumes the event off the bus.
    if (config.withSupervisor) {
        new Supervisor().join(env)
    }

    // Dialogue is an optional conversational supervisor, never a root
    // coordinator. It can explain observed state, send bounded worker messages,
    // and propose add-only work against the graph version it actually saw.
    // Board/Broker/repository/verifier retain every mutation, lease,
    // integration and completion authority; the run never awaits model calls.
    if (config.withDialogue) {
        if (!leaseBroker || !collectiveBoard) {
            throw new Error(
                "DialogueAgent requires the collective Board and LeaseBroker",
            )
        }
        const dialogueBackend = resolveDialogueBackend(config.dialogueLlm, llm)
        let responder = config.dialogueResponder
        if (!responder) {
            // Subscription harnesses normally discover project instructions
            // and read the checkout. Dialogue receives an explicit semantic
            // projection instead, so keep its provider process in an empty
            // run-local directory with no repository ancestry.
            dialogueRuntimeCwd = mkdtempSync(join(tmpdir(), "baro-dialogue-runtime-"))
            responder = createDialogueResponder({
                backend: dialogueBackend,
                cwd: dialogueRuntimeCwd,
                model: config.dialogueModel,
                timeoutMs: config.dialogueTimeoutMs,
                billingCoordinator: gatewayBillingCoordinator ?? undefined,
            })
        }
        dialogueAgent = new DialogueAgent({
            runId,
            responder,
            operatorAuthority: operator,
            leaseAuthority: leaseBroker,
            routeAuthoritiesByWorker: new Map(
                storyFactories.map((storyFactory) => [
                    storyFactory.getWorkerId(),
                    storyFactory,
                ] as const),
            ),
            controlAuthority: collectiveBoard,
            conversationContext,
            timeoutMs: config.dialogueTimeoutMs,
        })
        collectiveBoard.setConversationAuthority(dialogueAgent)
        dialogueAgent.join(env)
        cleanupDialogue = () => {
            if (dialogueAgent?.getEnvironments().includes(env)) {
                dialogueAgent.leave(env)
            }
        }
        if (emitTui) new DialogueForwarder(dialogueAgent).join(env)
        config.onDialogueReady?.(dialogueAgent)
    }
    // Do not expose the Operator until every consumer of its commands has
    // joined; startup-window commands are intentionally dropped by the CLI.
    config.onOperatorReady?.(operator)

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

    env.deliverSemanticEvent(
        operator,
        RunStartRequest.create({ reason: "orchestrate" }),
    )
    if (planningFeed && collectiveBoard) {
        // Do not expose the private ingress until start() has loaded the
        // bootstrap PRD and atomically installed the planning-open latch.
        await collectiveBoard.idle()
        config.onPlanningFeedReady?.(planningFeed)
    }
    const summary = await coordinationDone
    if (coordinationMode === "collective" && useGit) {
        baseSha = gitCoordinator?.runBaseSha() ?? null
    }
    // A conversation request must never become a liveness dependency. Leaving
    // aborts an in-flight responder without delaying verification/finalization.
    if (dialogueAgent?.getEnvironments().includes(env)) {
        dialogueAgent.leave(env)
    }
    // A verifier timeout cancels its child process through a semantic event.
    // Do not return while that cancellation/cleanup task is still settling.
    if (runVerifier) await runVerifier.idle()

    // Drain detached pushes + the single worktree merge-back push: after
    // conductor.done so the network can't stall the run, before the
    // Finalizer so its PR sees every commit.
    if (coordinationMode === "legacy" && gitCoordinator) {
        await gitCoordinator.finish()
    }

    // Critic may still be reading a story worktree after its terminal result.
    // Drain it before the backstop sweep releases any remaining repository
    // targets, then continue draining the other asynchronous observers.
    await withCriticEvidenceBarrier(critic, async () => {
        await worktrees?.cleanupAll()
    })

    // Drain in-flight async observers so their side effects land in the
    // audit log before this function returns.
    if (acceptanceGate) await acceptanceGate.idle()
    if (surgeon) await surgeon.idle()
    if (collaborationBridge) await collaborationBridge.idle()
    if (workContextProvider) await workContextProvider.idle()
    await reconcileGatewayBilling()
    for (const storyFactory of storyFactories) {
        storyFactory.finishRunTelemetry()
    }
    await modelTelemetryCollector.idle()
    // Await the PR before the TUI `done` event so the completion screen has
    // the PR URL the moment it renders instead of after a race.
    if (finalizer) await finalizer.complete()

    let filesCreated = 0
    let filesModified = 0
    let totalCommits = 0
    if (useGit && baseSha) {
        const [stats, commitCount] = await Promise.all([
            getGitFileStats(config.cwd, baseSha),
            getCommitCount(config.cwd, baseSha),
        ])
        filesCreated = stats.created
        filesModified = stats.modified
        totalCommits = commitCount

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
            verification_status: summary.verificationStatus,
            verification: summary.verification
                ? {
                      verification_id: summary.verification.verificationId,
                      status: summary.verification.status,
                      duration_ms: summary.verification.durationMs,
                      commands: summary.verification.commands.map((command) => ({
                          command: command.command,
                          status: command.status,
                          duration_ms: command.durationMs,
                          ...(command.tail ? { tail: command.tail } : {}),
                      })),
                  }
                : undefined,
            stats: {
                stories_completed: summary.completedStories.length,
                stories_skipped:
                    summary.failedStories.length + summary.droppedStories.length,
                total_commits: totalCommits,
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
    } finally {
        // Exceptions during setup, coordination, verification, or finalization
        // must not strand a correlated provider call without a final pull.
        cleanupDialogue?.()
        await reconcileGatewayBilling()
        if (dialogueRuntimeCwd) {
            rmSync(dialogueRuntimeCwd, { recursive: true, force: true })
        }
    }
}

/** Keep the dialogue lane on the selected harness when it has a safe text-only adapter. */
export function resolveDialogueBackend(
    configured: DialogueBackend | undefined,
    runBackend: NonNullable<OrchestrateConfig["llm"]>,
): DialogueBackend {
    if (configured !== undefined) return configured
    return runBackend
}

export function resolveDefaultStorySelector(args: {
    configured?: string
    tierMap?: TierMap
    collectiveWorkerCount: number
}): string {
    if (args.configured !== undefined) return args.configured
    if (args.collectiveWorkerCount > 0) return "default"
    if (args.tierMap && tierMapHasDefaultRoute(args.tierMap)) return "default"
    return "opus"
}

export function resolveSurgeonEscalationRoute(args: {
    surgeonLlm: NonNullable<OrchestrateConfig["surgeonLlm"]>
    surgeonModel?: string
    storyModel?: string
    tierMap?: TierMap
    collectiveWorkers?: readonly Pick<CollectiveWorkerCandidateConfig, "tiers">[]
}): string | undefined {
    if (args.storyModel) return undefined
    if (args.collectiveWorkers?.length) {
        return marketAcceptsTier(args.collectiveWorkers, "heavy")
            ? "heavy"
            : undefined
    }
    if (args.tierMap && tierMapHasExplicitTier(args.tierMap, "heavy")) {
        return "heavy"
    }
    const model =
        args.surgeonModel ??
        (args.surgeonLlm === "openai"
            ? "gpt-5.5"
            : args.surgeonLlm === "claude"
              ? "opus"
              : undefined)
    return model ? `${args.surgeonLlm}:${model}` : undefined
}

export function validateCollectiveWorkers(
    workers: readonly CollectiveWorkerCandidateConfig[],
    mode: CoordinationMode,
    storyModel: string | undefined,
): void {
    if (workers.length === 0) return
    if (mode !== "collective") {
        throw new Error("collectiveWorkers requires coordinationMode='collective'")
    }
    if (storyModel) {
        throw new Error(
            "collectiveWorkers cannot be combined with storyModel; candidates bid concrete routes",
        )
    }
    const workerIds = new Set<string>()
    const routeIds = new Set<string>()
    for (const [index, worker] of workers.entries()) {
        const label = `collective worker[${index}]`
        if (!worker || typeof worker !== "object") {
            throw new Error(`${label} must be an object`)
        }
        if (
            typeof worker.workerId !== "string" ||
            !worker.workerId.trim() ||
            worker.workerId !== worker.workerId.trim() ||
            workerIds.has(worker.workerId)
        ) {
            throw new Error(
                `${label}.workerId must be a trimmed, non-empty, unique string: ${String(worker.workerId)}`,
            )
        }
        if (
            typeof worker.routeId !== "string" ||
            !worker.routeId.trim() ||
            worker.routeId !== worker.routeId.trim() ||
            routeIds.has(worker.routeId)
        ) {
            throw new Error(
                `${label}.routeId must be a trimmed, non-empty, unique string: ${String(worker.routeId)}`,
            )
        }
        if (typeof worker.route !== "string" || !worker.route.trim()) {
            throw new Error(`${label}.route must be a non-empty string`)
        }
        if (
            !worker.estimate ||
            !isValidWorkBidEstimate(worker.estimate) ||
            (worker.estimate.estimateSource !== "configured" &&
                worker.estimate.estimateSource !== "historical")
        ) {
            throw new Error(`${label}.estimate is invalid`)
        }
        if (
            worker.maxConcurrent !== undefined &&
            (!Number.isInteger(worker.maxConcurrent) || worker.maxConcurrent <= 0)
        ) {
            throw new Error(
                `${label}.maxConcurrent must be a positive integer`,
            )
        }
        if (
            worker.tiers !== undefined &&
            (!Array.isArray(worker.tiers) ||
                worker.tiers.some((tier) => typeof tier !== "string" || !tier.trim()))
        ) {
            throw new Error(`${label}.tiers must contain non-empty strings`)
        }
        workerIds.add(worker.workerId)
        routeIds.add(worker.routeId)
    }
    for (const tier of ["default", "light", "standard", "heavy"] as const) {
        if (!marketAcceptsTier(workers, tier)) {
            throw new Error(
                `collective workers do not cover required story tier '${tier}'`,
            )
        }
    }
}

function marketAcceptsTier(
    workers: readonly Pick<CollectiveWorkerCandidateConfig, "tiers">[],
    tier: string,
): boolean {
    const wanted = canonicalTier(tier).toLowerCase()
    return workers.some((worker) => {
        const tiers = worker.tiers
        if (!tiers || tiers.length === 0) return true
        return tiers.some(
            (candidate) =>
                canonicalTier(candidate || "default").toLowerCase() === wanted,
        )
    })
}

function tierMapHasExplicitTier(map: TierMap, tier: string): boolean {
    const wanted = canonicalTier(tier).toLowerCase()
    return Object.keys(map).some(
        (candidate) => canonicalTier(candidate).toLowerCase() === wanted,
    )
}

function tierMapHasDefaultRoute(map: TierMap): boolean {
    return Object.keys(map).some((candidate) => {
        const key = canonicalTier(candidate).toLowerCase()
        return key === "default" || key === "*"
    })
}

function validateCollectiveMarketOptions(
    workerCount: number,
    mode: CoordinationMode,
    bidWindowMs: number | undefined,
    policy: WorkBidPolicy | undefined,
): void {
    if (workerCount === 0 && (bidWindowMs !== undefined || policy !== undefined)) {
        throw new Error("collective bid window/policy requires at least one worker candidate")
    }
    if (workerCount > 0 && mode !== "collective") {
        throw new Error("collective market requires coordinationMode='collective'")
    }
    if (
        bidWindowMs !== undefined &&
        (!Number.isFinite(bidWindowMs) || bidWindowMs < 0)
    ) {
        throw new Error("collectiveBidWindowMs must be finite and non-negative")
    }
    if (policy) selectWorkBid([], policy)
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
