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
    StoryResult,
    StorySpawnRequest,
    StorySpawned,
    type StorySpawnRequestData,
} from "../semantic-events.js"
import { CodexStoryAgent } from "./codex-story-agent.js"
import { OpenAIStoryAgent } from "./openai-story-agent.js"
import { OpenCodeStoryAgent } from "./opencode-story-agent.js"
import { PiStoryAgent } from "./pi-story-agent.js"
import { StoryAgent } from "./story-agent.js"
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
     * names ("opus", "sonnet", …) are Claude-flavoured and not
     * meaningful for OpenAI.
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
     * tier name (e.g. "opus" from the Planner's blast-radius
     * classification) and a binding exists, the story is routed to that
     * concrete backend+model — independent of `llm`. This is what lets a
     * single DAG mix claude / openai / codex stories. Absent → bare tier
     * names resolve on `llm` exactly as before.
     */
    tierMap?: TierMap
}

export class StoryFactory extends BaseObserver {
    // Typed as BaroEnvironment because StoryAgent.run() / join() still
    // expect the old environment type. Once StoryAgent migrates, this
    // narrows to vanilla AgenticEnvironment.
    private envRef: AgenticEnvironment | null = null
    private readonly active: Map<
        string,
        StoryAgent | OpenAIStoryAgent | CodexStoryAgent | OpenCodeStoryAgent | PiStoryAgent
    > = new Map()
    /** Story ids whose spawn is in progress (closes the await-create window). */
    private readonly spawning = new Set<string>()

    constructor(private readonly opts: StoryFactoryOptions) {
        super()
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

        // When a story finishes (passes or fails), drop our reference so
        // we can clean up its bus membership.
        if (StoryResult.is(event)) {
            const agent = this.active.get(event.data.storyId)
            if (agent && this.envRef) {
                agent.leave(this.envRef)
                this.active.delete(event.data.storyId)
            }
        }
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

        // Per-story worktree isolation (#50); falls back to the shared cwd.
        const storyCwd = this.opts.worktrees
            ? (await this.opts.worktrees.create(req.storyId)) ?? this.opts.cwd
            : this.opts.cwd

        const agent: StoryAgent | OpenAIStoryAgent | CodexStoryAgent | OpenCodeStoryAgent | PiStoryAgent =
            route.backend === "pi"
                ? new PiStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd: storyCwd,
                      model: route.model,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                  })
                : route.backend === "opencode"
                ? new OpenCodeStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd: storyCwd,
                      model: route.model,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                  })
                : route.backend === "codex"
                    ? new CodexStoryAgent({
                          id: req.storyId,
                          prompt: req.prompt,
                          cwd: storyCwd,
                          // undefined → let Codex pick its account default.
                          model: route.model,
                          retries: req.retries,
                          timeoutSecs: req.timeoutSecs,
                      })
                    : route.backend === "openai"
                        ? new OpenAIStoryAgent(
                              {
                                  id: req.storyId,
                                  prompt: req.prompt,
                                  cwd: storyCwd,
                                  model: route.model,
                                  retries: req.retries,
                                  timeoutSecs: req.timeoutSecs,
                              },
                              {
                                  model: route.model ?? this.opts.openaiModel,
                                  baseUrl: route.baseUrl,
                                  apiKey: route.apiKey,
                              },
                          )
                        : new StoryAgent({
                              id: req.storyId,
                              prompt: req.prompt,
                              cwd: storyCwd,
                              // undefined → StoryAgent applies its own default.
                              model: route.model,
                              effort: this.opts.effort,
                              retries: req.retries,
                              timeoutSecs: req.timeoutSecs,
                          })

        agent.join(this.envRef)
        this.active.set(req.storyId, agent)

        // The agent's run() returns a Promise but we don't await it
        // here — the StoryResult event will arrive on the bus when it
        // settles, and Conductor reacts to that. Pure fire-and-forget
        // event-driven flow.
        void agent.run(this.envRef)

        // Emit the "yes, agent spawned" notification so observers can
        // see the lifecycle. Conductor doesn't actually need this, but
        // it makes audit logs/replays much clearer.
        this.envRef.deliverSemanticEvent(
            this,
            StorySpawned.create({ storyId: req.storyId }),
        )
    }
}
