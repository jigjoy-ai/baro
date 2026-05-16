/**
 * High-level entry: build a Mozaik environment with all the standard
 * baro participants, run a PRD to completion, return a summary.
 *
 * Used by:
 *   - the Rust orchestrator client (via run-orchestrator.ts)
 *   - direct TS callers (tests, demos)
 */

import { mkdirSync } from "fs"
import { dirname } from "path"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
} from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "./bus.js"

import {
    GitGate,
    createOrCheckoutBranch,
    getGitFileStats,
    getHeadSha,
    gitPushWithRetry,
    isInsideGitRepo,
    safePullRebase,
} from "./git.js"
import { buildDag } from "./dag.js"
import { Auditor } from "./participants/auditor.js"
import {
    Conductor,
    ConductorRunSummary,
    ConductorStateItem,
} from "./participants/conductor.js"
import { Critic } from "./participants/critic.js"
import { CriticOpenAI } from "./participants/critic-openai.js"
import { Finalizer } from "./participants/finalizer.js"
import { Librarian } from "./participants/librarian.js"
import { Operator } from "./participants/operator.js"
import { Sentry } from "./participants/sentry.js"
import { StoryFactory } from "./participants/story-factory.js"
import { StoryResultItem, type StoryAgent } from "./participants/story-agent.js"
import { Surgeon, type PrdSnapshot } from "./participants/surgeon.js"
import { SurgeonOpenAI } from "./participants/surgeon-openai.js"
import { PrdFile, loadPrd } from "./prd.js"
import {
    AgentStateItem,
    ClaudeResultItem,
    ClaudeSystemItem,
    CoordinationItem,
    CritiqueItem,
    FinalizeStartedItem,
    PrCreatedItem,
    RunStartRequestItem,
} from "./types.js"
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
     * Which LLM provider drives the agents. `"claude"` (the current
     * default) uses the Claude Code CLI for Architect, Planner,
     * StoryAgent, Critic, and Surgeon. `"openai"` is wired through
     * end-to-end but no participant yet routes to Mozaik's native
     * OpenAI runner — each subsequent phase replaces one fallback with
     * a real OpenAI sibling. Until then, `"openai"` is a no-op
     * placeholder that runs the Claude flow.
     */
    llm?: "claude" | "openai"
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
    const env = new BaroEnvironment()
    const emitTui = config.emitTuiEvents ?? true
    const llm: "claude" | "openai" = config.llm ?? "claude"

    // Phase 3 (0.30): Critic and Surgeon now route to Mozaik OpenAI
    // siblings when llm=openai. Architect, Planner, and StoryAgent
    // still use the Claude CLI path — those siblings land in 0.31+.
    // Make the partial-transition status loud in the audit log.
    if (llm === "openai") {
        process.stderr.write(
            "[orchestrate] llm=openai: Critic + Surgeon route to Mozaik OpenAI; " +
            "Architect, Planner, StoryAgent still on Claude CLI (per-phase ports in 0.31+).\n",
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
        new BaroEventForwarder().join(env)
    }

    // Operator listens for external commands (wired from caller).
    const operator = new Operator(config.operatorHooks ?? {})
    operator.setEnvironment(env)
    operator.join(env)

    const useGit = config.withGit ?? (await isInsideGitRepo(config.cwd))
    const gitGate = new GitGate()
    let baseSha: string | null = null

    // Phase-2 observers — Librarian (cross-agent memory) and Sentry
    // (file conflict detection). Both default ON; either can be turned
    // off via the OrchestrateConfig flags.
    const useLibrarian = config.withLibrarian ?? true
    const useSentry = config.withSentry ?? true
    const librarian = useLibrarian ? new Librarian() : null
    const sentry = useSentry ? new Sentry() : null
    if (librarian) librarian.join(env)
    if (sentry) sentry.join(env)

    // Phase-4 observer — Surgeon (adaptive DAG mutation). Opt-in.
    // Joins early so it sees StoryResultItem-s from the moment the
    // Conductor starts running.
    let surgeon: Surgeon | SurgeonOpenAI | null = null
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
                })),
            }
        }
        // Factory: when llm=openai, route the LLM-backed Surgeon to
        // Mozaik's native OpenAI runner instead of `claude --print`.
        // The deterministic fallback path is shared between both — if
        // OpenAI errors out, SurgeonOpenAI still emits a skip ReplanItem.
        surgeon = llm === "openai"
            ? new SurgeonOpenAI({
                  snapshot,
                  model: config.surgeonModel ?? "gpt-5.4",
              })
            : new Surgeon({
                  snapshot,
                  useLlm: config.surgeonUseLlm ?? false,
                  model: config.surgeonModel ?? "opus",
              })
        surgeon.join(env)
    }

    // Phase-3 observer — Critic (live acceptance-criteria evaluator).
    // Opt-in (default OFF). Spawns `claude --model haiku` subprocesses
    // for each evaluation, inheriting Claude CLI auth.
    let critic: Critic | CriticOpenAI | null = null
    if (config.withCritic) {
        const prd = loadPrd(config.prdPath)
        const targets = new Map<string, readonly string[]>(
            prd.userStories
                .filter((s) => s.acceptance && s.acceptance.length > 0)
                .map((s) => [s.id, s.acceptance] as [string, readonly string[]]),
        )
        // Factory: when llm=openai, Critic runs every per-turn verdict
        // through Mozaik's OpenAI runner. The bus contract is identical
        // — same CritiqueItem shape, same AgentTargetedMessageItem
        // emission for corrective feedback — so downstream observers
        // (Cartographer, Auditor) don't notice the swap.
        critic = llm === "openai"
            ? new CriticOpenAI({
                  targets,
                  model: config.criticModel ?? "gpt-5.4-mini",
              })
            : new Critic({
                  targets,
                  model: config.criticModel ?? "haiku",
              })
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
        timeoutSecs: config.timeoutSecs ?? 600,
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
                  await safePullRebase(
                      config.cwd,
                      (line) =>
                          emitTui && emit({ type: "story_log", id: storyId, line }),
                      gitGate,
                  )
                  try {
                      await gitPushWithRetry(gitGate, {
                          cwd: config.cwd,
                          onLog: (line) =>
                              emitTui &&
                              emit({ type: "story_log", id: storyId, line }),
                      })
                      if (emitTui) {
                          emit({
                              type: "push_status",
                              id: storyId,
                              success: true,
                              error: null,
                          })
                      }
                  } catch (e) {
                      if (emitTui) {
                          emit({
                              type: "push_status",
                              id: storyId,
                              success: false,
                              error: (e as Error)?.message ?? String(e),
                          })
                      }
                  }
              }
            : undefined,
    })
    conductor.setEnvironment(env)
    conductor.join(env)

    // Story factory — Mozaik-native participant that spawns StoryAgent
    // instances in response to StorySpawnRequestItem from Conductor.
    // Replaces the old `new StoryAgent(...).run()` direct call inside
    // Conductor; now Conductor doesn't import StoryAgent at all.
    const storyFactory = new StoryFactory({ cwd: config.cwd })
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
    env.deliverBusEvent(operator, new RunStartRequestItem("orchestrate"))
    const summary = await conductor.done

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
 * Translates bus events into the legacy BaroEvent shape consumed by the
 * Rust TUI. Lives inside this module so callers don't have to wire
 * sinks themselves.
 */
class BaroEventForwarder extends BaroParticipant {
    /** Story IDs that have already received a `story_start`. */
    private startedStories = new Set<string>()
    /** Number of in-flight retry attempts per story (for `story_retry`). */
    private retryCounts = new Map<string, number>()
    /** Token-usage tally per story (incrementally updated from results). */
    private tokensByStory = new Map<string, { input: number; output: number }>()

    override async onExternalModelMessage(source: Participant, item: ModelMessageItem): Promise<void> {
        this.handleModelMessage(source, item)
    }

    override async onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> {
        this.handleToolCall(source, item)
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        this.handleToolResult(source, item)
    }

    override async onExternalBusEvent(_source: Participant, event: BusEvent): Promise<void> {
        if (event instanceof ConductorStateItem) {
            this.handleConductorState(event)
            return
        }

        if (event instanceof StoryResultItem) {
            this.handleStoryResult(event)
            return
        }

        if (event instanceof ClaudeResultItem) {
            this.handleClaudeResult(event)
            return
        }

        if (event instanceof AgentStateItem) {
            this.handleAgentState(event)
            return
        }

        if (event instanceof ClaudeSystemItem) {
            // Mostly noise; emit only init transitions (already covered
            // by AgentStateItem) — skip.
            return
        }

        if (event instanceof CoordinationItem) {
            this.handleCoordination(event)
            return
        }

        if (event instanceof CritiqueItem) {
            this.handleCritique(event)
            return
        }

        if (event instanceof FinalizeStartedItem) {
            emit({ type: "finalize_start" })
            return
        }

        if (event instanceof PrCreatedItem) {
            emit({ type: "finalize_complete", pr_url: event.url })
            return
        }
    }

    private handleCoordination(item: CoordinationItem): void {
        emit({
            type: "story_log",
            id: item.recipientId,
            line: `[sentry/${item.kind}] ${item.reason}`,
        })
    }

    private handleCritique(item: CritiqueItem): void {
        emit({
            type: "story_log",
            id: item.agentId,
            line: `[critic/${item.verdict}] ${item.reasoning}`,
        })
    }

    private handleConductorState(item: ConductorStateItem): void {
        // Mirror conductor lifecycle as a `progress` event the existing
        // Rust TUI understands — it doesn't yet know `conductor_state`.
        if (
            item.phase === "running_level" &&
            item.currentLevel != null &&
            item.totalLevels != null
        ) {
            emit({
                type: "progress",
                completed: item.currentLevel - 1,
                total: item.totalLevels,
                percentage: Math.round(
                    ((item.currentLevel - 1) / Math.max(1, item.totalLevels)) * 100,
                ),
            })
        }
    }

    private handleStoryResult(item: StoryResultItem): void {
        if (item.success) {
            emit({
                type: "story_complete",
                id: item.storyId,
                duration_secs: item.durationSecs,
                files_created: 0,
                files_modified: 0,
            })
        } else {
            emit({
                type: "story_error",
                id: item.storyId,
                error: item.error ?? "unknown error",
                attempt: item.attempts,
                max_retries: item.attempts,
            })
        }
    }

    private handleClaudeResult(item: ClaudeResultItem): void {
        const usage = item.usage as
            | { input_tokens?: number; output_tokens?: number }
            | null
        const inputTokens =
            typeof usage?.input_tokens === "number" ? usage.input_tokens : 0
        const outputTokens =
            typeof usage?.output_tokens === "number"
                ? usage.output_tokens
                : 0
        const tally = this.tokensByStory.get(item.agentId) ?? { input: 0, output: 0 }
        tally.input += inputTokens
        tally.output += outputTokens
        this.tokensByStory.set(item.agentId, tally)
        emit({
            type: "token_usage",
            id: item.agentId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
        })
    }

    private handleAgentState(item: AgentStateItem): void {
        if (item.phase === "running" && !this.startedStories.has(item.agentId)) {
            this.startedStories.add(item.agentId)
            emit({ type: "story_start", id: item.agentId, title: item.agentId })
        }
        if (item.phase === "waiting" && item.detail?.includes("retrying")) {
            const count = (this.retryCounts.get(item.agentId) ?? 0) + 1
            this.retryCounts.set(item.agentId, count)
            emit({ type: "story_retry", id: item.agentId, attempt: count })
        }
    }

    private handleModelMessage(source: Participant, item: ModelMessageItem): void {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const json = item.toJSON() as { content: Array<{ text: string }> }
        const text = json.content?.[0]?.text ?? ""
        if (!text.trim()) return
        emitMultiline(agentId, text)
    }

    private handleToolCall(source: Participant, item: FunctionCallItem): void {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        // Tool args can themselves contain newlines (multi-line file
        // contents in a Write call, embedded code blocks, etc). Split.
        emitMultiline(agentId, `[tool_call] ${item.name} ${item.args}`)
    }

    private handleToolResult(
        source: Participant,
        item: FunctionCallOutputItem,
    ): void {
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const json = item.toJSON() as {
            call_id: string
            output: Array<{ text: string }>
        }
        const text = json.output?.[0]?.text ?? ""
        emitMultiline(agentId, `[tool_result ${json.call_id}] ${text}`)
    }
}

/**
 * Emit a story_log per source line. Keeps the TUI clean (no embedded
 * `\n` rendered as ⏎ literals) and lets the log scrollbar work as
 * intended on long tool outputs.
 */
function emitMultiline(agentId: string, text: string): void {
    if (!text) return
    const lines = text.split("\n")
    for (const line of lines) {
        // Skip purely empty trailing lines but keep blank rows mid-block
        // so structure (e.g. paragraph breaks) survives.
        if (line.length === 0 && lines.length === 1) continue
        emit({ type: "story_log", id: agentId, line })
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

