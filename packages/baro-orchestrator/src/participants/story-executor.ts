/**
 * StoryExecutor — the seam between "decide a story should run" and "run its
 * agent loop somewhere" (in-process, mock, or remote). Every implementation
 * must deliver the agent's bus events — ending in the terminal `StoryResult` —
 * onto the local env. Collective executors must copy `runId`, `leaseId`, and
 * `generation` from the request into that terminal result.
 */

import { AgenticEnvironment, type Participant } from "@mozaik-ai/core"

import type { GatewayBillingCoordinator } from "../billing/index.js"
import type { StorySpawnRequestData } from "../semantic-events.js"
import type { StoryRoute } from "../routing.js"
import { CodexStoryAgent } from "./codex-story-agent.js"
import { OpenAIStoryAgent } from "./openai-story-agent.js"
import { OpenCodeStoryAgent } from "./opencode-story-agent.js"
import { PiStoryAgent } from "./pi-story-agent.js"
import { StoryAgent } from "./story-agent.js"

export interface StoryExecOpts {
    /** Default model for the OpenAI path when the route names none. */
    openaiModel?: string
    /** Effort level for the Claude path (`claude --effort`). */
    effort?: string
    /** Repository/Board participant authorized to decide native runtime DAG
     * proposals. Omitted outside correlated collective execution. */
    runtimeReplanDecisionAuthority?: Participant
    /** Bound for a native story tool to receive its correlated decision. */
    runtimeReplanDecisionTimeoutMs?: number
    /** Exact Critic participant whose terminal-turn verdict may resume a
     * continuation-capable worker. */
    turnReviewAuthority?: Participant
    turnReviewTimeoutMs?: number
    /** Exact run-scoped collaboration transport for native StoryAgent tools. */
    collaboration?: Readonly<{
        commandPath: string
        sessionDir: string
    }>
    /** Exact run-scoped trusted Gateway billing interceptor. */
    billingCoordinator?: GatewayBillingCoordinator
    /**
     * Collective executors must synchronously register the exact Participant
     * that will source StoryResult before emitting a result or returning from
     * start(). Legacy execution leaves this unset.
     */
    registerResultAuthority?: (source: Participant) => void
    /**
     * Register an exact nested producer of terminal-turn evidence before it
     * joins the bus. Collective policy consumers reject unregistered sources.
     */
    registerTerminalAuthority?: (source: Participant) => void
}

export interface StoryExecution {
    /** Release bus membership / resources after the StoryResult lands. */
    dispose(env: AgenticEnvironment): void
    /**
     * Abort early (Supervisor uses this on a detected stall); the agent then
     * settles with a failed StoryResult, which the Surgeon reacts to.
     * Optional so custom executors need not implement it.
     */
    abort?(): void
}

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

interface TerminalSourceRegistrant {
    setTerminalSourceRegistrar(
        register: (source: Participant) => void,
    ): void
}

/** In-process executor: builds the backend agent for the resolved route. */
export class LocalStoryExecutor implements StoryExecutor {
    start(
        req: StorySpawnRequestData,
        route: StoryRoute,
        cwd: string,
        env: AgenticEnvironment,
        opts: StoryExecOpts,
    ): StoryExecution {
        const correlation = {
            runId: req.runId,
            leaseId: req.leaseId,
            generation: req.generation,
        }
        const agent: AnyStoryAgent =
            route.backend === "pi"
                ? new PiStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd,
                      model: route.model,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                      ...correlation,
                  })
                : route.backend === "opencode"
                ? new OpenCodeStoryAgent({
                      id: req.storyId,
                      prompt: req.prompt,
                      cwd,
                      model: route.model,
                      retries: req.retries,
                      timeoutSecs: req.timeoutSecs,
                      ...correlation,
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
                      ...correlation,
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
                          graphVersion: req.graphVersion,
                          requiresQualityReview: req.requiresQualityReview,
                          ...correlation,
                      },
                      {
                          model: route.model ?? opts.openaiModel,
                          baseUrl: route.baseUrl,
                          apiKey: route.apiKey,
                          runtimeReplanDecisionAuthority:
                              opts.runtimeReplanDecisionAuthority,
                          runtimeReplanDecisionTimeoutMs:
                              opts.runtimeReplanDecisionTimeoutMs,
                          turnReviewAuthority: opts.turnReviewAuthority,
                          turnReviewTimeoutMs: opts.turnReviewTimeoutMs,
                          collaboration: opts.collaboration,
                          billingCoordinator: opts.billingCoordinator,
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
                      requiresQualityReview: req.requiresQualityReview,
                      turnReviewAuthority: opts.turnReviewAuthority,
                      turnReviewTimeoutMs: opts.turnReviewTimeoutMs,
                      ...correlation,
                  })

        if (
            opts.registerTerminalAuthority &&
            "setTerminalSourceRegistrar" in agent
        ) {
            const registrant = agent as AnyStoryAgent & TerminalSourceRegistrant
            registrant.setTerminalSourceRegistrar(opts.registerTerminalAuthority)
        }
        if (opts.registerResultAuthority) {
            agent.setResultAuthority(agent)
            opts.registerResultAuthority(agent)
        }

        agent.join(env)

        // Fire-and-forget: Conductor reacts to the StoryResult bus event.
        void agent.run(env)

        return {
            dispose: (e: AgenticEnvironment) => agent.leave(e),
            abort: () => (agent as { abort?: () => void }).abort?.(),
        }
    }
}
