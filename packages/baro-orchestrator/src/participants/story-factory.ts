/**
 * StoryFactory — Mozaik-native participant that spawns StoryAgent
 * instances in response to StorySpawnRequest events on the bus.
 *
 * Why a factory? It removes the direct coupling between Conductor and
 * StoryAgent. The Conductor only emits "I'd like a story to run with
 * these specs"; the factory is responsible for the lifecycle.
 *
 * Replacing this factory (e.g. with a mock for tests, or with a
 * remote-execution variant) requires no changes to Conductor.
 */

import {
    BaseObserver,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import { AgenticEnvironment } from "@mozaik-ai/core"
import {
    StoryIntervention,
    StoryResult,
    StoryRouted,
    StorySpawnRequest,
    StorySpawned,
    type StorySpawnRequestData,
} from "../semantic-events.js"
import {
    LocalStoryExecutor,
    type StoryExecution,
    type StoryExecutor,
} from "./story-executor.js"
import {
    formatRoute,
    resolveStoryRoute,
    type EndpointMap,
    type TierMap,
} from "../routing.js"
import type { WorktreeManager } from "../worktree.js"

export interface StoryFactoryOptions {
    cwd: string
    /**
     * When set, each story runs in its own isolated git worktree instead of
     * the shared `cwd` (issue #50). create() falls back to `cwd` on failure.
     */
    worktrees?: WorktreeManager
    /**
     * Which LLM provider every story uses.
     *   "claude"  — StoryAgent wrapping a `claude` CLI subprocess
     *   "openai"  — OpenAIStoryAgent driving Mozaik's native OpenAI
     *               runner with our codebase tool layer
     *   "codex"   — CodexStoryAgent wrapping a `codex exec --json`
     *               subprocess (ChatGPT subscription billing path)
     *   "opencode" — OpenCodeStoryAgent wrapping an `opencode run --format json`
     *               subprocess
     *   "pi"      — PiStoryAgent wrapping a `pi --mode json -p` subprocess
     * Same bus contract for all — Conductor, Critic, Surgeon,
     * Sentry, Librarian, Cartographer don't notice the swap.
     */
    llm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    /**
     * Optional model name to pass to OpenAI agents. Default
     * `gpt-5.5` — StoryAgent's coding loop benefits from the largest
     * context window + reasoning.
     */
    openaiModel?: string
    /**
     * If set, overrides EVERY story's `model` field at spawn time —
     * for both Claude and OpenAI paths. Wins over the per-PRD-story
     * `model`. `openaiModel` above is still applied when this is
     * undefined and the path is OpenAI, since the PRD's `model`
     * names are tiers ("heavy", "standard", …) and not meaningful
     * for OpenAI.
     */
    storyModelOverride?: string
    /**
     * Named OpenAI-compatible endpoints (from `--openai-endpoint`).
     * Routes of the form `openai:model@name` resolve their base URL +
     * key here so several endpoints can run in one DAG.
     */
    endpoints?: EndpointMap
    /** Default API key for inline `@https://…` endpoints (OPENAI_API_KEY). */
    defaultApiKey?: string
    /**
     * Effort level for the Claude path, passed as `claude --effort`
     * (low|medium|high|xhigh|max). Ignored by the OpenAI path.
     */
    effort?: string
    /**
     * Tier→`backend:model` bindings. When a story's `model` is a bare
     * tier name (e.g. "heavy" from the Planner's blast-radius
     * classification) and a binding exists, the story is routed to that
     * concrete backend+model — independent of `llm`. This is what lets a
     * single DAG mix claude / openai / codex stories. Absent → bare tier
     * names resolve on `llm` exactly as before.
     */
    tierMap?: TierMap
    /**
     * Where stories actually run. Default: in-process (`LocalStoryExecutor`).
     * Inject an alternative — a mock for tests, or an out-of-process / remote
     * executor — to run the agent loop elsewhere without touching any other
     * participant.
     */
    executor?: StoryExecutor
}

export class StoryFactory extends BaseObserver {
    /** The bus environment, wired in before any spawn; passed to the executor. */
    private envRef: AgenticEnvironment | null = null
    private readonly active: Map<string, StoryExecution> = new Map()
    /** Story ids whose spawn is in progress (closes the await-create window). */
    private readonly spawning = new Set<string>()
    private readonly executor: StoryExecutor

    constructor(private readonly opts: StoryFactoryOptions) {
        super()
        this.executor = opts.executor ?? new LocalStoryExecutor()
    }

    setEnvironment(env: AgenticEnvironment): void {
        this.envRef = env
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (StorySpawnRequest.is(event)) {
            await this.spawn(event.data)
            return
        }

        if (StoryIntervention.is(event) && event.data.action === "abort") {
            const aborted = this.abort(event.data.storyId)
            if (aborted) {
                process.stderr.write(
                    `[story-factory] ${event.data.storyId} aborted (${event.data.source}): ${event.data.reason}\n`,
                )
            }
            return
        }

        // When a story finishes (passes or fails), dispose its execution so we
        // can clean up its bus membership / executor resources.
        if (StoryResult.is(event)) {
            const exec = this.active.get(event.data.storyId)
            if (exec && this.envRef) {
                exec.dispose(this.envRef)
                this.active.delete(event.data.storyId)
            }
        }
    }

    /**
     * Abort a running story mid-flight (StoryIntervention from the bus, or the
     * Operator's external abort). The agent settles with a failed StoryResult,
     * which the Surgeon then reacts to (split/escalate). Returns false if the
     * story isn't active or its executor doesn't support abort.
     */
    abort(storyId: string): boolean {
        const exec = this.active.get(storyId)
        if (!exec?.abort) return false
        exec.abort()
        return true
    }

    private async spawn(req: StorySpawnRequestData): Promise<void> {
        if (!this.envRef) return
        // Idempotent across both the settled set and the in-progress set:
        // spawn awaits worktree creation, so a duplicate request must not slip
        // through that window and create a second worktree + agent. The
        // finally clears the in-progress marker even if construction throws,
        // so a later recovery respawn of this story isn't blocked forever.
        if (this.active.has(req.storyId) || this.spawning.has(req.storyId)) return
        this.spawning.add(req.storyId)
        try {
            await this.buildAndLaunch(req)
        } finally {
            this.spawning.delete(req.storyId)
        }
    }

    private async buildAndLaunch(req: StorySpawnRequestData): Promise<void> {
        if (!this.envRef) return

        // Resolve which backend + model THIS story runs on. The route
        // can come from the story's own `model` field (a bare tier name
        // or an explicit `backend:model`), the tier map, or the global
        // `--story-model` override. `llm` is only the fallback backend
        // when the route names none — so one DAG can mix all three
        // backends story-by-story.
        const route = resolveStoryRoute(req.model, {
            tierMap: this.opts.tierMap,
            fallbackBackend: this.opts.llm ?? "claude",
            openaiDefaultModel: this.opts.openaiModel ?? "gpt-5.5",
            override: this.opts.storyModelOverride,
            endpoints: this.opts.endpoints,
            defaultApiKey: this.opts.defaultApiKey,
        })

        process.stderr.write(
            `[story-factory] ${req.storyId} → ${formatRoute(route)}` +
                (req.model ? ` (model="${req.model}")` : "") +
                "\n",
        )
        this.envRef.deliverSemanticEvent(
            this,
            StoryRouted.create({
                storyId: req.storyId,
                backend: route.backend,
                model: route.model ?? "default",
            }),
        )

        // Per-story worktree isolation (#50); falls back to the shared cwd.
        const storyCwd = this.opts.worktrees
            ? (await this.opts.worktrees.create(req.storyId)) ?? this.opts.cwd
            : this.opts.cwd

        // Run the story — in-process by default, or via an injected executor
        // that runs it elsewhere. Either way the StoryResult lands on the bus
        // when it settles, and Conductor reacts.
        const exec = this.executor.start(req, route, storyCwd, this.envRef, {
            openaiModel: this.opts.openaiModel,
            effort: this.opts.effort,
        })
        this.active.set(req.storyId, exec)

        // Emit the "yes, agent spawned" notification so observers can
        // see the lifecycle. Conductor doesn't actually need this, but
        // it makes audit logs/replays much clearer.
        this.envRef.deliverSemanticEvent(
            this,
            StorySpawned.create({ storyId: req.storyId }),
        )
    }
}
