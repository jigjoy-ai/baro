/**
 * Shared skeleton for one-shot CLI surgeons (Codex, OpenCode, Pi): observes
 * terminal story failures, asks the LLM for a structured replan (split /
 * prereq / rewire / skip / abort), emits a Replan the coordinator applies,
 * and falls back to the deterministic strategy on any subprocess or parsing
 * error. A backend contributes only its subprocess invocation.
 *
 * Prompts, JSON extraction, and the deterministic fallback come from
 * `surgeon.ts` so every backend shares one source of truth for the contract.
 */

import { BaseObserver, Participant, SemanticEvent } from "../runtime/mozaik.js"

import { runnerMeasurement } from "../runner-measurement.js"
import type { RunnerInvocationObserver } from "../runner-invocation.js"
import {
    ModelInvocationMeasured,
    RecoveryDecision,
    RecoveryEvaluationStarted,
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    type StoryResultData,
} from "../semantic-events.js"
import { ActiveLeaseRegistry } from "../runtime/active-lease-registry.js"
import { RecoverySourceAuthority } from "../runtime/recovery-source-authority.js"
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"
import { correlateRecoveryReplan, recoveryInput } from "./recovery-input.js"
import {
    PrdSnapshot,
    type RouteDescriber,
    SURGEON_SYSTEM_PROMPT,
    buildSurgeonPrompt,
    CritiqueLog,
    extractJsonObject,
    surgeonDeterministicReplan,
} from "./surgeon.js"

export interface OneShotSurgeonCoreOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (issue #48). */
    resolveRoute?: RouteDescriber
    /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
    escalationRoute?: string
    /** Use the backend CLI to evaluate replans. Default: true. */
    useLlm?: boolean
    /** Max replans this Surgeon will emit per run. Default: unlimited. */
    maxReplans?: number
    /** Per-evaluation timeout in milliseconds. Default: 300_000 (5 min). */
    timeoutMs?: number
    runId?: string
    emitRecoveryDecisions?: boolean
    /** Collective-only dynamic authority for terminal execution results. */
    outcomeAuthority?: StoryOutcomeAuthority
}

export interface OneShotSurgeonBackendSpec {
    /** Lowercase telemetry backend tag and fallback-reason label. */
    backend: "codex" | "opencode" | "pi"
    /** RecoveryDecision source identity, e.g. "surgeon:codex". */
    sourceTag: string
}

export interface OneShotSurgeonInvocationContext {
    timeoutMs: number
    onInvocation: RunnerInvocationObserver
}

export abstract class OneShotSurgeon extends BaseObserver {
    private readonly useLlm: boolean
    private readonly maxReplans: number
    protected readonly timeoutMs: number
    private readonly snapshot: () => PrdSnapshot
    private readonly resolveRoute?: RouteDescriber
    private readonly escalationRoute?: string
    private readonly runId?: string
    private readonly emitRecoveryDecisions?: boolean

    private replansEmitted = 0
    private readonly critiques = new CritiqueLog()
    private readonly leases = new ActiveLeaseRegistry()
    private readonly sources: RecoverySourceAuthority
    private readonly pending = new Set<Promise<void>>()
    private evaluationSequence = 0

    protected constructor(
        core: OneShotSurgeonCoreOptions,
        private readonly backendSpec: OneShotSurgeonBackendSpec,
        /** Telemetry model, when explicitly requested. */
        private readonly requestedModel: string | undefined,
    ) {
        super()
        this.sources = new RecoverySourceAuthority(core.outcomeAuthority)
        this.useLlm = core.useLlm ?? true
        this.maxReplans = core.maxReplans ?? Infinity
        this.timeoutMs = core.timeoutMs ?? 300_000
        this.snapshot = core.snapshot
        this.resolveRoute = core.resolveRoute
        this.escalationRoute = core.escalationRoute
        this.runId = core.runId
        this.emitRecoveryDecisions = core.emitRecoveryDecisions
    }

    /** Run one evaluator subprocess and return its raw response text. */
    protected abstract invoke(
        prompt: string,
        context: OneShotSurgeonInvocationContext,
    ): Promise<string>

    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    setLeaseAuthority(authority: Participant): void {
        this.sources.setLeaseAuthority(authority)
    }

    setQualityAuthority(authority: Participant): void {
        this.sources.setQualityAuthority(authority)
    }

    setBlockAuthority(authority: Participant): void {
        this.sources.setBlockAuthority(authority)
    }

    setCriticAuthority(authority: Participant): void {
        this.sources.setCriticAuthority(authority)
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (this.sources.observeLease(source, event, this.leases, this.runId)) return
        if (!this.sources.accepts(source, event)) return
        this.critiques.record(event)
        const failure = recoveryInput(event)
        if (!failure) return
        if (
            this.emitRecoveryDecisions &&
            !this.leases.consumeResult(failure, this.runId)
        ) return
        if (this.replansEmitted >= this.maxReplans) {
            this.emitRecoveryDecision(failure, "abort", "replan budget exhausted")
            return
        }

        this.emitRecoveryStarted(failure)
        const evaluation = this.useLlm ? ++this.evaluationSequence : null

        const work = (async () => {
            try {
                const replan = this.useLlm
                    ? await this.evaluateWithLlm(failure, evaluation!)
                    : surgeonDeterministicReplan(failure)
                if (!replan) {
                    this.emitRecoveryDecision(failure, "abort", "surgeon chose abort")
                    return
                }
                this.replansEmitted += 1
                for (const env of this.getEnvironments()) {
                    env.deliverSemanticEvent(
                        this,
                        Replan.create(correlateRecoveryReplan(replan, failure)),
                    )
                }
                this.emitRecoveryDecision(failure, "replan", replan.reason)
            } catch (error) {
                this.emitRecoveryDecision(
                    failure,
                    "abort",
                    `surgeon failed: ${(error as Error)?.message ?? String(error)}`,
                )
            }
        })()

        this.pending.add(work)
        work.finally(() => this.pending.delete(work))
        await work
    }

    private emitRecoveryStarted(failure: StoryResultData): void {
        if (!this.emitRecoveryDecisions || !this.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, RecoveryEvaluationStarted.create({
                runId: this.runId,
                storyId: failure.storyId,
                source: this.backendSpec.sourceTag,
            }))
        }
    }

    private emitRecoveryDecision(
        failure: StoryResultData,
        action: "replan" | "abort",
        reason: string,
    ): void {
        if (!this.emitRecoveryDecisions || !this.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, RecoveryDecision.create({
                runId: this.runId,
                storyId: failure.storyId,
                source: this.backendSpec.sourceTag,
                action,
                reason,
            }))
        }
    }

    private async evaluateWithLlm(
        failure: StoryResultData,
        evaluation: number,
    ): Promise<ReplanData | null> {
        const snap = this.snapshot()
        const userPrompt = buildSurgeonPrompt(
            snap,
            failure,
            this.resolveRoute,
            this.escalationRoute,
            this.critiques.forStory(failure.storyId),
        )
        const prompt = `${SURGEON_SYSTEM_PROMPT}\n\n${userPrompt}`

        try {
            const text = await this.invoke(prompt, {
                timeoutMs: this.timeoutMs,
                onInvocation: this.invocationObserver(failure, evaluation),
            })
            const verdictText = text.trim()
            if (!verdictText) throw new Error("empty result")

            const verdictJson = extractJsonObject(verdictText)
            const parsed = JSON.parse(verdictJson) as {
                action: string
                reason?: string
                added?: ReplanStoryAdd[]
                removed?: string[]
                modifiedDeps?: { id: string; newDependsOn: string[] }[]
            }

            if (parsed.action === "abort") return null

            // Model output is untrusted: keep only structurally valid
            // mutations and let downstream validators own semantics.
            const addedStories = (parsed.added ?? []).filter(
                (s): s is ReplanStoryAdd =>
                    s != null &&
                    typeof s.id === "string" &&
                    typeof s.title === "string" &&
                    typeof s.description === "string" &&
                    typeof s.priority === "number" &&
                    Array.isArray(s.dependsOn),
            )
            const removedStoryIds = (parsed.removed ?? []).filter(
                (r): r is string => typeof r === "string",
            )
            const modifiedDeps: Record<string, readonly string[]> = {}
            for (const m of parsed.modifiedDeps ?? []) {
                if (typeof m.id === "string" && Array.isArray(m.newDependsOn)) {
                    modifiedDeps[m.id] = [...m.newDependsOn]
                }
            }
            return {
                source: "surgeon",
                reason: `${parsed.action}: ${parsed.reason ?? ""}`,
                addedStories,
                removedStoryIds,
                modifiedDeps,
            }
        } catch (err) {
            // Fall back to deterministic so the run still has a chance
            // to recover.
            const fallback = surgeonDeterministicReplan(failure)
            return {
                ...fallback,
                reason: `${fallback.reason} (${this.backendSpec.backend} fallback after error: ${(err as Error)?.message ?? String(err)})`,
            }
        }
    }

    private invocationObserver(
        failure: StoryResultData,
        evaluation: number,
    ): RunnerInvocationObserver {
        const runId = failure.runId ?? this.runId ?? null
        const leaseSuffix = failure.leaseId
            ? `:lease:${failure.leaseId}`
            : ""
        const generationSuffix = failure.generation !== undefined
            ? `:generation:${failure.generation}`
            : ""
        return (observation) => {
            const event = ModelInvocationMeasured.create(
                runnerMeasurement(
                    {
                        invocationBaseId: `${runId ?? "local"}:surgeon:${failure.storyId}:${evaluation}${leaseSuffix}${generationSuffix}`,
                        runId,
                        phase: "surgeon",
                        storyId: failure.storyId,
                        turn: evaluation,
                        backend: this.backendSpec.backend,
                        requestedModel: this.requestedModel ?? null,
                    },
                    observation,
                ),
            )
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, event)
            }
        }
    }
}
