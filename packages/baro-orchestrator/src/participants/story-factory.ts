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
import { StoryAgent } from "./story-agent.js"
import { formatRoute, resolveStoryRoute, type TierMap } from "../routing.js"

export interface StoryFactoryOptions {
    cwd: string
    /**
     * Which LLM provider every story uses.
     *   "claude"  — StoryAgent wrapping a `claude` CLI subprocess
     *   "openai"  — OpenAIStoryAgent driving Mozaik's native OpenAI
     *               runner with our codebase tool layer
     *   "codex"   — CodexStoryAgent wrapping a `codex exec --json`
     *               subprocess (ChatGPT subscription billing path)
     * Same bus contract for all three — Conductor, Critic, Surgeon,
     * Sentry, Librarian, Cartographer don't notice the swap.
     */
    llm?: "claude" | "openai" | "codex"
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
        StoryAgent | OpenAIStoryAgent | CodexStoryAgent
    > = new Map()

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
        if (this.active.has(req.storyId)) return // idempotent

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
        })

        process.stderr.write(
            `[story-factory] ${req.storyId} → ${formatRoute(route)}` +
                (req.model ? ` (model="${req.model}")` : "") +
                "\n",
        )

        const agent: StoryAgent | OpenAIStoryAgent | CodexStoryAgent =
            route.backend === "codex"
                ? new CodexStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd: this.opts.cwd,
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
                              cwd: this.opts.cwd,
                              model: route.model,
                              retries: req.retries,
                              timeoutSecs: req.timeoutSecs,
                          },
                          { model: route.model ?? this.opts.openaiModel },
                      )
                    : new StoryAgent({
                          id: req.storyId,
                          prompt: req.prompt,
                          cwd: this.opts.cwd,
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
