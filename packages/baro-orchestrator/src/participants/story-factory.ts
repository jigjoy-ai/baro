/**
 * StoryFactory — Mozaik-native participant that spawns StoryAgent
 * instances in response to StorySpawnRequestItem events on the bus.
 *
 * Why a factory? It removes the direct coupling between Conductor and
 * StoryAgent. The Conductor only emits "I'd like a story to run with
 * these specs"; the factory is responsible for the lifecycle.
 *
 * Replacing this factory (e.g. with a mock for tests, or with a
 * remote-execution variant) requires no changes to Conductor.
 */

import { Participant } from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../bus.js"
import {
    StorySpawnRequestItem,
    StorySpawnedItem,
} from "../types.js"
import { OpenAIStoryAgent } from "./openai-story-agent.js"
import { StoryAgent, StoryResultItem } from "./story-agent.js"

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

export class StoryFactory extends BaroParticipant {
    private envRef: BaroEnvironment | null = null
    private readonly active: Map<string, StoryAgent | OpenAIStoryAgent> = new Map()

    constructor(private readonly opts: StoryFactoryOptions) {
        super()
    }

    setEnvironment(env: BaroEnvironment): void {
        this.envRef = env
    }

    override async onExternalBusEvent(_source: Participant, event: BusEvent): Promise<void> {
        if (event instanceof StorySpawnRequestItem) {
            await this.spawn(event)
            return
        }

        // When a story finishes (passes or fails), drop our reference so
        // we can clean up its bus membership.
        if (event instanceof StoryResultItem) {
            const agent = this.active.get(event.storyId)
            if (agent && this.envRef) {
                agent.leave(this.envRef)
                this.active.delete(event.storyId)
            }
        }
    }

    private async spawn(req: StorySpawnRequestItem): Promise<void> {
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
                      appendSystemPrompt: req.appendSystemPrompt,
                  })

        agent.join(this.envRef)
        this.active.set(req.storyId, agent)

        // The agent's run() returns a Promise but we don't await it
        // here — the StoryResultItem will arrive on the bus when it
        // settles, and Conductor reacts to that. Pure fire-and-forget
        // event-driven flow.
        void agent.run(this.envRef)

        // Emit the "yes, agent spawned" notification so observers can
        // see the lifecycle. Conductor doesn't actually need this, but
        // it makes audit logs/replays much clearer.
        this.envRef.deliverBusEvent(this, new StorySpawnedItem(req.storyId))
    }
}
