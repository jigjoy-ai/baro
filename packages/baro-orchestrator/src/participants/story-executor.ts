/**
 * StoryExecutor — the seam between "decide a story should run" and "actually
 * run its agent loop somewhere".
 *
 * The default implementation (`LocalStoryExecutor`) builds the right backend
 * agent and runs it in-process — the historical behaviour. The seam lets that
 * be swapped: a mock executor for tests, or an out-of-process / remote executor
 * that runs the agent elsewhere and re-emits its streamed bus events onto the
 * local `env`. Whatever the implementation, it must deliver the agent's events,
 * including the terminal `StoryResult`, onto the bus — so Conductor / Critic /
 * Surgeon / Sentry / Librarian / Cartographer can't tell which executor ran.
 * That indistinguishability is the point: every other participant stays
 * unchanged regardless of where execution happens.
 */

import { AgenticEnvironment } from "@mozaik-ai/core"

import type { StorySpawnRequestData } from "../semantic-events.js"
import type { StoryRoute } from "../routing.js"
import { CodexStoryAgent } from "./codex-story-agent.js"
import { OpenAIStoryAgent } from "./openai-story-agent.js"
import { OpenCodeStoryAgent } from "./opencode-story-agent.js"
import { PiStoryAgent } from "./pi-story-agent.js"
import { StoryAgent } from "./story-agent.js"

/** Backend-shaping knobs the factory owns and forwards to the executor. */
export interface StoryExecOpts {
    /** Default model for the OpenAI path when the route names none. */
    openaiModel?: string
    /** Effort level for the Claude path (`claude --effort`). */
    effort?: string
}

/** A story that has started running. `dispose` detaches it once it settles. */
export interface StoryExecution {
    /** Release bus membership / resources after the StoryResult lands. */
    dispose(env: AgenticEnvironment): void
    /**
     * Abort the running agent early (Supervisor uses this on a detected stall).
     * The agent settles with a failed StoryResult, which the Surgeon then reacts
     * to. Optional so custom executors need not implement it.
     */
    abort?(): void
}

/**
 * Where a story's agent loop runs. `start` must kick off execution and ensure
 * the agent's bus events (ending in `StoryResult`) reach `env`; it returns a
 * handle the factory disposes when the story settles.
 */
export interface StoryExecutor {
    start(
        req: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        env: AgenticEnvironment,
        opts: StoryExecOpts,
    ): StoryExecution
}

type AnyStoryAgent =
    | StoryAgent
    | OpenAIStoryAgent
    | CodexStoryAgent
    | OpenCodeStoryAgent
    | PiStoryAgent

/**
 * In-process executor — the historical path. Builds the backend agent for the
 * resolved route, joins it to the bus, and fire-and-forgets its run loop; the
 * StoryResult arrives on the bus when it settles.
 */
export class LocalStoryExecutor implements StoryExecutor {
    start(
        req: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        env: AgenticEnvironment,
        opts: StoryExecOpts,
    ): StoryExecution {
        const agent: AnyStoryAgent =
            route.backend === "pi"
                ? new PiStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd,
                      model: route.model,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                  })
                : route.backend === "opencode"
                ? new OpenCodeStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd,
                      model: route.model,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                  })
                : route.backend === "codex"
                ? new CodexStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd,
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
                          cwd,
                          model: route.model,
                          retries: req.retries,
                          timeoutSecs: req.timeoutSecs,
                      },
                      {
                          model: route.model ?? opts.openaiModel,
                          baseUrl: route.baseUrl,
                          apiKey: route.apiKey,
                      },
                  )
                : new StoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd,
                      // undefined → StoryAgent applies its own default.
                      model: route.model,
                      effort: opts.effort,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                  })

        agent.join(env)

        // Fire-and-forget: the StoryResult event arrives on the bus when the
        // run settles, and Conductor reacts to that.
        void agent.run(env)

        return {
            dispose: (e: AgenticEnvironment) => agent.leave(e),
            abort: () => (agent as { abort?: () => void }).abort?.(),
        }
    }
}
