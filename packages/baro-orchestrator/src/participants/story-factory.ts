/**
 * StoryFactory — Mozaik-native participant that spawns StoryAgent
 * instances in response to StorySpawnRequest events on the bus.
 *
 * It removes direct coupling between either coordinator and StoryAgent:
 * coordinators request work, while the factory owns agent lifecycle.
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
import type { GatewayBillingCoordinator } from "../billing/index.js"
import {
    RunCompleted,
    RunStartRequest,
    ModelInvocationMeasured,
    RouteEstimateUpdated,
    StoryIntervention,
    StoryResult,
    StoryRouted,
    StorySpawnFailed,
    StorySpawnRequest,
    StorySpawned,
    WorkClaimed,
    WorkBid,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkOffered,
    WorkerCapabilityAdvertised,
    type StorySpawnRequestData,
    type WorkOfferedData,
    type WorkLeaseGrantedData,
    type WorkBidEstimateData,
    type WorkRouteDescriptor,
} from "../semantic-events.js"
import {
    LocalStoryExecutor,
    type StoryExecution,
    type StoryExecutor,
} from "./story-executor.js"
import { RouteLearner } from "./route-learning.js"
import {
    formatRoute,
    canonicalTier,
    resolveStoryRoute,
    type EndpointMap,
    type TierMap,
    type StoryRoute,
} from "../routing.js"
import { isValidWorkBidEstimate } from "../work-market.js"
import type { WorktreeManager } from "../worktree.js"
import {
    StoryOutcomeAuthority,
    type StoryResultAuthorityCorrelation,
} from "../runtime/story-outcome-authority.js"
import { classifyStoryFailure } from "../provider-failure.js"

export interface StoryFactoryOptions {
    cwd: string
    coordinationMode?: "legacy" | "collective"
    runId?: string
    workerId?: string
    /** Object-identity authority allowed to grant/release collective leases. */
    leaseAuthority?: Participant
    /** Exact CollectiveBoard allowed to publish executable work offers. */
    offerAuthority?: Participant
    /** Shared run-scoped authority for dynamic factory/agent outcomes. */
    outcomeAuthority?: StoryOutcomeAuthority
    /** Collective Board allowed to answer native `propose_replan` tool calls. */
    runtimeReplanDecisionAuthority?: Participant
    /** Exact Critic allowed to complete a continuation-capable worker turn. */
    turnReviewAuthority?: Participant
    /** Bound for the Critic handshake before an infrastructure failure. */
    turnReviewTimeoutMs?: number
    /** Exact telemetry reducer whose measurements may influence advisory bids. */
    telemetryAuthority?: Participant
    collaboration?: {
        commandPath: string
        sessionDir: string
    }
    /**
     * When set, each story runs in its own isolated git worktree instead of
     * the shared `cwd` (issue #50). Collective mode requires this isolation.
     */
    worktrees?: WorktreeManager
    /** Fail the lease when an isolated worktree cannot be created. */
    requireWorktree?: boolean
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
    /** Run-scoped correlation for the explicitly trusted Baro Gateway. */
    billingCoordinator?: GatewayBillingCoordinator
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
    /** Opt-in market candidate. Credentials remain in the resolved route here. */
    bid?: StoryFactoryBidOptions
}

export interface StoryFactoryBidOptions {
    routeId: string
    /** Existing backend:model@endpoint route syntax. */
    route: string
    estimate: WorkBidEstimateData
    /** Bare PRD tiers this candidate accepts; absent means every offer. */
    tiers?: readonly string[]
    maxConcurrent?: number
}

export class StoryFactory extends BaseObserver {
    /** The bus environment, wired in before any spawn; passed to the executor. */
    private envRef: AgenticEnvironment | null = null
    private readonly active: Map<string, StoryExecution> = new Map()
    /** Story ids whose spawn is in progress (closes the await-create window). */
    private readonly spawning = new Set<string>()
    /** Terminal results delivered synchronously from inside executor.start(). */
    private readonly settledWhileSpawning = new Set<string>()
    private readonly leases = new Map<string, WorkLeaseGrantedData>()
    /** Retained until run completion so delayed authoritative billing for a
     * released lease cannot be attributed to a newer retry. */
    private readonly telemetryLeases = new Map<
        string,
        { storyId: string; generation: number }
    >()
    private readonly bidRoutes = new Map<
        string,
        { offerId: string; route: StoryRoute; descriptor: WorkRouteDescriptor }
    >()
    private readonly leasedRoutes = new Map<string, StoryRoute>()
    private readonly executor: StoryExecutor
    private readonly bidOptions: StoryFactoryBidOptions | null
    private readonly routeLearner: RouteLearner | null
    private readonly configuredBidRoute: {
        route: StoryRoute
        descriptor: WorkRouteDescriptor
    } | null

    constructor(private readonly opts: StoryFactoryOptions) {
        super()
        if (opts.coordinationMode === "collective" && !opts.leaseAuthority) {
            throw new Error("collective StoryFactory requires a leaseAuthority")
        }
        if (opts.coordinationMode === "collective" && !opts.offerAuthority) {
            throw new Error("collective StoryFactory requires an offerAuthority")
        }
        if (opts.coordinationMode === "collective" && !opts.outcomeAuthority) {
            throw new Error("collective StoryFactory requires an outcomeAuthority")
        }
        if (
            opts.coordinationMode === "collective" &&
            opts.outcomeAuthority?.runId !== this.runId()
        ) {
            throw new Error("collective StoryFactory outcomeAuthority runId mismatch")
        }
        this.executor = opts.executor ?? new LocalStoryExecutor()
        this.bidOptions = opts.bid
            ? {
                  ...opts.bid,
                  estimate: { ...opts.bid.estimate },
                  ...(opts.bid.tiers ? { tiers: [...opts.bid.tiers] } : {}),
              }
            : null
        this.routeLearner = this.bidOptions
            ? new RouteLearner(this.bidOptions.estimate)
            : null
        this.configuredBidRoute = this.bidOptions
            ? this.resolveBidRoute(this.bidOptions)
            : null
    }

    /** Stable market identity used to source-bind lease-adjacent observers. */
    getWorkerId(): string {
        return this.workerId()
    }

    /**
     * Called only after the authoritative billing feed has completed its final
     * reconciliation. RunCompleted itself can precede a late cloud receipt, so
     * clearing lease correlation there would make route learning order-racy.
     */
    finishRunTelemetry(): void {
        this.telemetryLeases.clear()
        this.routeLearner?.clearPending()
    }

    setEnvironment(env: AgenticEnvironment): void {
        this.envRef = env
        if (this.opts.coordinationMode === "collective") {
            // Advertise as soon as the worker joins. Board preparation can
            // synchronously emit offers before the outer RunStart event reaches
            // later participants, so waiting only for RunStart loses early bids.
            this.advertiseCapabilities()
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        await this.handleEvent(event, source, false)
    }

    override async onInternalEvent(event: SemanticEvent<unknown>): Promise<void> {
        await this.handleEvent(event, null, true)
    }

    private async handleEvent(
        event: SemanticEvent<unknown>,
        source: Participant | null,
        internal: boolean,
    ): Promise<void> {
        if (
            this.opts.coordinationMode === "collective" &&
            this.bidOptions &&
            source === this.opts.telemetryAuthority &&
            ModelInvocationMeasured.is(event)
        ) {
            const measurement = event.data
            const correlation = measurement.leaseId
                ? this.telemetryLeases.get(measurement.leaseId)
                : undefined
            if (
                measurement.runId === this.runId() &&
                measurement.phase === "story" &&
                measurement.storyId &&
                correlation?.storyId === measurement.storyId &&
                measurement.generation === correlation.generation
            ) {
                const learned = this.routeLearner!.observeInvocation(
                    measurement.leaseId!,
                    measurement,
                )
                if (learned) this.publishLearnedEstimate(learned)
            }
            return
        }
        if (
            this.opts.coordinationMode === "collective" &&
            RunStartRequest.is(event)
        ) {
            this.advertiseCapabilities()
            return
        }

        if (
            this.opts.coordinationMode === "collective" &&
            WorkOffered.is(event) &&
            event.data.runId === this.runId() &&
            source === this.opts.offerAuthority
        ) {
            if (this.bidOptions) this.bid(event.data)
            else this.claim(event.data)
            return
        }

        if (
            this.opts.coordinationMode === "collective" &&
            WorkLeaseGranted.is(event) &&
            event.data.runId === this.runId() &&
            source === this.opts.leaseAuthority
        ) {
            if (event.data.workerId !== this.workerId()) return
            this.opts.outcomeAuthority!.registerSpawnAuthority(
                {
                    runId: event.data.runId,
                    storyId: event.data.request.storyId,
                    leaseId: event.data.leaseId,
                },
                this,
            )
            if (this.bidOptions) {
                for (const [bidId, stored] of this.bidRoutes) {
                    if (
                        stored.offerId === event.data.offerId &&
                        bidId !== event.data.bidId
                    ) this.bidRoutes.delete(bidId)
                }
            }
            if (this.bidOptions) {
                const stored = event.data.bidId
                    ? this.bidRoutes.get(event.data.bidId)
                    : undefined
                if (
                    !stored ||
                    stored.offerId !== event.data.offerId ||
                    !event.data.route ||
                    !sameRouteDescriptor(stored.descriptor, event.data.route)
                ) {
                    this.emitBus(
                        StorySpawnFailed.create({
                            runId: event.data.runId,
                            offerId: event.data.offerId,
                            leaseId: event.data.leaseId,
                            storyId: event.data.request.storyId,
                            error: "market lease did not match the worker's stored bid",
                            failure: {
                                kind: "infrastructure",
                                code: "decision_unknown",
                            },
                        }),
                    )
                    return
                }
                this.leasedRoutes.set(event.data.request.storyId, stored.route)
            }
            this.leases.set(event.data.request.storyId, event.data)
            this.telemetryLeases.set(event.data.leaseId, {
                storyId: event.data.request.storyId,
                generation: event.data.generation,
            })
            this.routeLearner?.beginLease(
                event.data.leaseId,
                event.data.request.storyId,
            )
            this.emitBus(
                StorySpawnRequest.create({
                    ...event.data.request,
                    offerId: event.data.offerId,
                    runId: event.data.runId,
                    leaseId: event.data.leaseId,
                    generation: event.data.generation,
                    workerId: event.data.workerId,
                }),
            )
            return
        }

        if (StorySpawnRequest.is(event)) {
            if (this.opts.coordinationMode === "collective") {
                // Collective spawn requests are projected by this worker only
                // after an authorized lease. Never trust an external replay.
                if (!internal) return
                const lease = this.leases.get(event.data.storyId)
                if (
                    !lease ||
                    event.data.runId !== this.runId() ||
                    event.data.workerId !== this.workerId() ||
                    event.data.leaseId !== lease.leaseId ||
                    event.data.generation !== lease.generation
                ) return
            }
            await this.spawn(event.data)
            return
        }

        if (
            this.opts.coordinationMode === "collective" &&
            WorkLeaseReleased.is(event) &&
            event.data.runId === this.runId() &&
            source === this.opts.leaseAuthority
        ) {
            const lease = this.leases.get(event.data.storyId)
            if (lease?.leaseId === event.data.leaseId) {
                if (this.routeLearner && this.configuredBidRoute) {
                    const learned = this.routeLearner.completeLease(
                        event.data.storyId,
                        event.data.leaseId,
                        event.data.reason,
                    )
                    this.publishLearnedEstimate(learned)
                }
                const exec = this.active.get(event.data.storyId)
                if (exec && this.envRef) {
                    exec.abort?.()
                    exec.dispose(this.envRef)
                    this.active.delete(event.data.storyId)
                }
                this.leases.delete(event.data.storyId)
                this.routeLearner?.forgetLease(
                    event.data.storyId,
                    event.data.leaseId,
                )
                this.leasedRoutes.delete(event.data.storyId)
                if (lease.bidId) this.bidRoutes.delete(lease.bidId)
            }
            return
        }

        if (
            RunCompleted.is(event) &&
            (this.opts.coordinationMode !== "collective" ||
                (event.data.runId === this.runId() &&
                    source === this.opts.runtimeReplanDecisionAuthority))
        ) {
            this.bidRoutes.clear()
            this.leasedRoutes.clear()
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
            if (this.opts.coordinationMode === "collective") {
                if (
                    !source ||
                    !this.opts.outcomeAuthority!.matchesResult(source, event.data)
                ) return
                const lease = this.leases.get(event.data.storyId)
                if (
                    !lease ||
                    event.data.runId !== this.runId() ||
                    event.data.leaseId !== lease.leaseId ||
                    event.data.generation !== lease.generation
                ) return
            }
            const exec = this.active.get(event.data.storyId)
            if (exec && this.envRef) {
                exec.dispose(this.envRef)
                this.active.delete(event.data.storyId)
            } else if (this.spawning.has(event.data.storyId)) {
                this.settledWhileSpawning.add(event.data.storyId)
            }
        }
    }

    private claim(offer: WorkOfferedData): void {
        try {
            const route = this.resolveRoute(offer.request.model)
            this.emitBus(
                WorkClaimed.create({
                    runId: offer.runId,
                    offerId: offer.offerId,
                    storyId: offer.request.storyId,
                    workerId: this.workerId(),
                    backend: route.backend,
                    model: route.model ?? "default",
                }),
            )
        } catch (error) {
            process.stderr.write(
                `[story-factory] cannot claim ${offer.request.storyId}: ${(error as Error)?.message ?? String(error)}\n`,
            )
        }
    }

    private bid(offer: WorkOfferedData): void {
        const configured = this.configuredBidRoute
        const bid = this.bidOptions
        if (!configured || !bid || !this.acceptsTier(offer.request.model)) return
        if (offer.excludedRouteIds?.includes(configured.descriptor.routeId)) return
        const bidId = `${offer.offerId}:${this.workerId()}:${bid.routeId}`
        this.bidRoutes.set(bidId, {
            offerId: offer.offerId,
            route: configured.route,
            descriptor: configured.descriptor,
        })
        this.emitBus(
            WorkBid.create({
                runId: offer.runId,
                offerId: offer.offerId,
                storyId: offer.request.storyId,
                generation: offer.generation,
                bidId,
                workerId: this.workerId(),
                route: configured.descriptor,
                estimate: this.routeLearner!.currentEstimate(),
            }),
        )
    }

    private publishLearnedEstimate(
        learned: ReturnType<RouteLearner["completeLease"]>,
    ): void {
        if (!this.configuredBidRoute) return
        this.emitBus(
            RouteEstimateUpdated.create({
                runId: this.runId(),
                workerId: this.workerId(),
                route: { ...this.configuredBidRoute.descriptor },
                ...learned,
            }),
        )
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
        } catch (error) {
            const message = (error as Error)?.message ?? String(error)
            const failure = classifyStoryFailure(error) ?? {
                kind: "infrastructure" as const,
                code: /worktree/i.test(message)
                    ? "worktree_unavailable" as const
                    : "process_spawn_failed" as const,
            }
            process.stderr.write(`[story-factory] ${req.storyId} spawn failed: ${message}\n`)
            this.emitBus(
                StorySpawnFailed.create({
                    runId: this.runId(),
                    offerId: req.offerId,
                    leaseId: req.leaseId,
                    storyId: req.storyId,
                    error: message,
                    failure,
                }),
            )
            if (this.opts.coordinationMode !== "collective") {
                this.emitBus(
                    StoryResult.create({
                        storyId: req.storyId,
                        success: false,
                        attempts: 0,
                        durationSecs: 0,
                        error: `spawn failed: ${message}`,
                        failure,
                        ...(req.runId && req.leaseId && req.generation != null
                            ? {
                                  runId: req.runId,
                                  leaseId: req.leaseId,
                                  generation: req.generation,
                              }
                            : {}),
                    }),
                )
            }
        } finally {
            this.spawning.delete(req.storyId)
            this.settledWhileSpawning.delete(req.storyId)
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
        const route = this.leasedRoutes.get(req.storyId) ?? this.resolveRoute(req.model)
        const executionRequest =
            this.opts.collaboration && req.leaseId
                ? {
                      ...req,
                      prompt: `${req.prompt}\n\n${this.collaborationInstructions(
                          req.storyId,
                          req.leaseId,
                          req.graphVersion,
                          route.backend !== "openai",
                      )}`,
                  }
                : req

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
                ...(this.opts.coordinationMode === "collective" &&
                req.runId &&
                req.leaseId &&
                req.generation != null
                    ? {
                          runId: req.runId,
                          leaseId: req.leaseId,
                          generation: req.generation,
                      }
                    : {}),
            }),
        )

        // Legacy may fall back to cwd; collective treats missing isolation as failure.
        const createdWorktree = this.opts.worktrees
            ? await this.opts.worktrees.create(req.storyId)
            : null
        if (this.opts.worktrees && !createdWorktree && this.opts.requireWorktree) {
            throw new Error(`isolated worktree unavailable for ${req.storyId}`)
        }
        const storyCwd = createdWorktree ?? this.opts.cwd

        // Run the story — in-process by default, or via an injected executor
        // that runs it elsewhere. Either way the StoryResult lands on the bus
        // when it settles, and Conductor reacts.
        let resultAuthorityRegistered = false
        const collectiveCorrelation = this.opts.coordinationMode === "collective"
            ? this.resultCorrelation(req)
            : null
        const exec = this.executor.start(executionRequest, route, storyCwd, this.envRef, {
            openaiModel: this.opts.openaiModel,
            effort: this.opts.effort,
            ...(route.backend === "openai" &&
            this.opts.runtimeReplanDecisionAuthority
                ? {
                      runtimeReplanDecisionAuthority:
                          this.opts.runtimeReplanDecisionAuthority,
                  }
                : {}),
            ...(this.opts.turnReviewAuthority
                ? {
                      turnReviewAuthority: this.opts.turnReviewAuthority,
                      turnReviewTimeoutMs: this.opts.turnReviewTimeoutMs,
                  }
                : {}),
            ...(route.backend === "openai" && this.opts.collaboration
                ? { collaboration: this.opts.collaboration }
                : {}),
            ...(route.backend === "openai" && this.opts.billingCoordinator
                ? { billingCoordinator: this.opts.billingCoordinator }
                : {}),
            ...(collectiveCorrelation
                ? {
                      registerResultAuthority: (source: Participant) => {
                          this.opts.outcomeAuthority!.registerResultAuthority(
                              collectiveCorrelation,
                              source,
                          )
                          resultAuthorityRegistered = true
                      },
                      registerTerminalAuthority: (source: Participant) => {
                          this.opts.outcomeAuthority!.registerTerminalAuthority(
                              collectiveCorrelation,
                              source,
                          )
                      },
                  }
                : {}),
        })
        if (collectiveCorrelation && !resultAuthorityRegistered) {
            try {
                exec.abort?.()
            } catch (error) {
                process.stderr.write(
                    `[story-factory] ${req.storyId} unregistered executor abort failed: ${String(error)}\n`,
                )
            }
            try {
                exec.dispose(this.envRef)
            } catch (error) {
                process.stderr.write(
                    `[story-factory] ${req.storyId} unregistered executor dispose failed: ${String(error)}\n`,
                )
            }
            throw new Error(
                "collective executor returned without registering its StoryResult authority",
            )
        }

        if (this.settledWhileSpawning.delete(req.storyId)) {
            exec.dispose(this.envRef)
        } else {
            this.active.set(req.storyId, exec)
        }

        // Emit the "yes, agent spawned" notification so observers can
        // see the lifecycle. Conductor doesn't actually need this, but
        // it makes audit logs/replays much clearer.
        this.envRef.deliverSemanticEvent(
            this,
            StorySpawned.create({ storyId: req.storyId }),
        )
    }

    private resolveRoute(model: string) {
        return resolveStoryRoute(model, {
            tierMap: this.opts.tierMap,
            fallbackBackend: this.opts.llm ?? "claude",
            openaiDefaultModel: this.opts.openaiModel ?? "gpt-5.5",
            override: this.opts.storyModelOverride,
            endpoints: this.opts.endpoints,
            defaultApiKey: this.opts.defaultApiKey,
        })
    }

    private resultCorrelation(
        req: StorySpawnRequestData,
    ): StoryResultAuthorityCorrelation {
        if (
            req.runId !== this.runId() ||
            !req.leaseId ||
            req.generation == null
        ) {
            throw new Error(
                `collective story ${req.storyId} is missing lease correlation`,
            )
        }
        return {
            runId: req.runId,
            storyId: req.storyId,
            leaseId: req.leaseId,
            generation: req.generation,
        }
    }

    private resolveBidRoute(bid: StoryFactoryBidOptions): {
        route: StoryRoute
        descriptor: WorkRouteDescriptor
    } {
        if (!bid.routeId.trim()) throw new Error("market routeId must not be empty")
        if (!isValidWorkBidEstimate(bid.estimate)) {
            throw new Error(`invalid market estimate for route ${bid.routeId}`)
        }
        if (
            bid.estimate.estimateSource !== "configured" &&
            bid.estimate.estimateSource !== "historical"
        ) {
            throw new Error(`invalid estimate source for route ${bid.routeId}`)
        }
        if (
            bid.maxConcurrent !== undefined &&
            (!Number.isInteger(bid.maxConcurrent) || bid.maxConcurrent <= 0)
        ) {
            throw new Error(`maxConcurrent must be a positive integer for route ${bid.routeId}`)
        }
        const route = resolveStoryRoute(bid.route, {
            fallbackBackend: this.opts.llm ?? "claude",
            openaiDefaultModel: this.opts.openaiModel ?? "gpt-5.5",
            endpoints: this.opts.endpoints,
            defaultApiKey: this.opts.defaultApiKey,
        })
        return {
            route,
            descriptor: {
                routeId: bid.routeId,
                backend: route.backend,
                model: route.model ?? "default",
            },
        }
    }

    private acceptsTier(model: string): boolean {
        const tiers = this.bidOptions?.tiers
        if (!tiers || tiers.length === 0) return true
        const wanted = canonicalTier(model || "default").toLowerCase()
        return tiers.some(
            (tier) => canonicalTier(tier || "default").toLowerCase() === wanted,
        )
    }

    private emitBus(event: SemanticEvent<unknown>): void {
        this.envRef?.deliverSemanticEvent(this, event)
    }

    private advertiseCapabilities(): void {
        this.emitBus(
            workerCapabilityEvent(
                this.runId(),
                this.workerId(),
                this.configuredBidRoute?.descriptor ?? {
                    routeId: `default:${this.opts.llm ?? "claude"}`,
                    backend: this.opts.llm ?? "claude",
                    model: "default",
                },
                this.bidOptions?.maxConcurrent,
            ),
        )
    }

    private workerId(): string {
        return this.opts.workerId ?? `story-worker:${this.opts.llm ?? "claude"}`
    }

    private runId(): string {
        return this.opts.runId ?? "legacy"
    }

    private collaborationInstructions(
        storyId: string,
        leaseId: string,
        graphVersion?: number,
        includeCliDagMutationCommands = true,
    ): string {
        const collaboration = this.opts.collaboration!
        const command = `node ${JSON.stringify(collaboration.commandPath)}`
        const session = JSON.stringify(collaboration.sessionDir)
        const lease = JSON.stringify(leaseId)
        return [
            "## Collective coordination",
            "",
            "You are an autonomous peer on the shared Baro event bus. Use these commands only when they help the goal:",
            `- Ask peers: ${command} emit --session ${session} --lease ${lease} --kind help --text ${JSON.stringify("YOUR QUESTION")}`,
            `- Message a peer: ${command} emit --session ${session} --lease ${lease} --kind message --to S2 --text ${JSON.stringify("YOUR MESSAGE")} (queued if that peer starts in a later wave)`,
            `- Share a finding: ${command} emit --session ${session} --lease ${lease} --kind note --text ${JSON.stringify("YOUR FINDING")} (retained in later agents' launch context)`,
            `- Read peer messages: ${command} inbox --session ${session} --agent ${JSON.stringify(storyId)}`,
            ...(includeCliDagMutationCommands
                ? [
                      ...(graphVersion !== undefined
                          ? [
                                `- The launch DAG version is ${graphVersion}. To atomically add, replace, or rewire future work and receive the Board's decision immediately: ${command} emit --session ${session} --lease ${lease} --kind replan --base-version ${graphVersion} --replan-json ${JSON.stringify('{"addedStories":[],"removedStoryIds":[],"modifiedDeps":{}}')} --reason ${JSON.stringify("WHY THE PLAN MUST CHANGE")}`,
                                "  Use the newest `graphVersion` returned by a prior decision. Active/already-started stories are immutable; express additional work as future stories.",
                                `  If replan exits 3 or returns \`outcome_unknown\`, do not assume whether it applied. Resolve that same proposal before continuing: ${command} decision --session ${session} --proposal ${JSON.stringify("PROPOSAL_ID")} --wait-ms 30000`,
                            ]
                          : []),
                  ]
                : []),
            "Check the inbox after initial exploration and before finishing. Do not create coordination noise for routine work.",
        ].join("\n")
    }
}

function workerCapabilityEvent(
    runId: string,
    workerId: string,
    route: WorkRouteDescriptor,
    maxConcurrent?: number,
) {
    const live = route.backend === "claude" || route.backend === "openai"
    return WorkerCapabilityAdvertised.create({
        runId,
        workerId,
        capabilities: {
            backends: [route.backend],
            supportsAbort: true,
            supportsLiveFeedback: live,
            supportsPeerMessages: live,
            routes: [route],
            ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
        },
    })
}

function sameRouteDescriptor(
    left: WorkRouteDescriptor,
    right: WorkRouteDescriptor,
): boolean {
    return (
        left.routeId === right.routeId &&
        left.backend === right.backend &&
        left.model === right.model
    )
}
