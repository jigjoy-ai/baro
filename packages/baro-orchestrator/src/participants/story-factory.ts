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

import { BaroEnvironment } from "../bus.js"
import {
    StoryResult,
    StorySpawnRequest,
    StorySpawned,
    type StorySpawnRequestData,
} from "../semantic-events.js"
import { OpenAIStoryAgent } from "./openai-story-agent.js"
import { StoryAgent } from "./story-agent.js"

export interface StoryFactoryOptions {
    cwd: string
    /**
     * Which LLM provider every story uses. When `"openai"`, spawned
     * agents are `OpenAIStoryAgent`-s driving Mozaik's native OpenAI
     * runner with our codebase tool layer. When `"claude"` (default),
     * agents are the legacy `StoryAgent` wrapping a `claude` CLI
     * subprocess. Same bus contract either way — Conductor, Critic,
     * Surgeon, Sentry, Librarian, Cartographer don't notice the swap.
     */
    llm?: "claude" | "openai"
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
}

export class StoryFactory extends BaseObserver {
    // Typed as BaroEnvironment because StoryAgent.run() / join() still
    // expect the old environment type. Once StoryAgent migrates, this
    // narrows to vanilla AgenticEnvironment.
    private envRef: BaroEnvironment | null = null
    private readonly active: Map<string, StoryAgent | OpenAIStoryAgent> = new Map()

    constructor(private readonly opts: StoryFactoryOptions) {
        super()
    }

    setEnvironment(env: BaroEnvironment): void {
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

        const llm = this.opts.llm ?? "claude"

        // Provider factory: same StorySpec shape feeds both sides;
        // the OpenAI agent ignores `model` (uses its own gpt-5.x
        // mapping via openaiModel) and the Claude agent ignores the
        // OpenAI-specific timeouts.
        // `storyModelOverride` (from `--story-model`) wins over the
        // per-PRD model. Empty/absent → use the per-story value.
        const claudeModel = this.opts.storyModelOverride ?? req.model
        const openaiModel =
            this.opts.storyModelOverride ?? this.opts.openaiModel ?? "gpt-5.5"

        const agent: StoryAgent | OpenAIStoryAgent =
            llm === "openai"
                ? new OpenAIStoryAgent(
                      {
                          id: req.storyId,
                          prompt: req.prompt,
                          cwd: this.opts.cwd,
                          model: req.model,
                          retries: req.retries,
                          timeoutSecs: req.timeoutSecs,
                      },
                      { model: openaiModel },
                  )
                : new StoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd: this.opts.cwd,
                      model: claudeModel,
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
