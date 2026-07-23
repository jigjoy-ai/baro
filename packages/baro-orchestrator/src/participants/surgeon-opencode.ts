/**
 * SurgeonOpenCode — adaptive DAG mutation via
 * `opencode run --format json`. Sibling of `surgeon.ts` (Claude),
 * `surgeon-openai.ts` (OpenAI API), and `surgeon-codex.ts` (Codex CLI).
 *
 * Same bus contract as the other variants: observes terminal story
 * failures, asks the LLM for a structured replan (split / prereq /
 * rewire / skip / abort), emits a ReplanItem the Conductor applies at
 * the next level boundary. Falls back to deterministic skip if the LLM
 * call fails or returns malformed JSON.
 *
 * Library-grade: reuses prompts + JSON-extractor + deterministic
 * fallback from `surgeon.ts` directly so the four backends share one
 * source of truth for the contract.
 */

import { BaseObserver, Participant, SemanticEvent } from "../runtime/mozaik.js"

import { runOpenCodeOneShot } from "../opencode-one-shot.js"
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

export interface SurgeonOpenCodeOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (issue #48). */
    resolveRoute?: RouteDescriber
    /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
    escalationRoute?: string
    /** Use OpenCode CLI to evaluate replans. Default: true. */
    useLlm?: boolean
    /**
     * Model identifier in `provider/model` format
     * (e.g. "anthropic/claude-sonnet-4"). Omit to use OpenCode's
     * configured default.
     */
    model?: string
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /** Path to the `opencode` binary. Default: "opencode". */
    opencodeBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 300_000 (5 min). */
    timeoutMs?: number
    runId?: string
    emitRecoveryDecisions?: boolean
    /** Collective-only dynamic authority for terminal execution results. */
    outcomeAuthority?: StoryOutcomeAuthority
}

export class SurgeonOpenCode extends BaseObserver {
    private readonly opts: Required<
        Omit<SurgeonOpenCodeOptions, "snapshot" | "model" | "opencodeBin" | "resolveRoute" | "escalationRoute" | "runId" | "emitRecoveryDecisions" | "outcomeAuthority">
    > & {
        snapshot: () => PrdSnapshot
        model: string | undefined
        opencodeBin: string
        resolveRoute?: RouteDescriber
        /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
        escalationRoute?: string
        runId?: string
        emitRecoveryDecisions?: boolean
    }

    private replansEmitted = 0
    private readonly critiques = new CritiqueLog()
    private readonly leases = new ActiveLeaseRegistry()
    private readonly sources: RecoverySourceAuthority
    private readonly pending = new Set<Promise<void>>()
    private evaluationSequence = 0

    constructor(opts: SurgeonOpenCodeOptions) {
        super()
        this.sources = new RecoverySourceAuthority(opts.outcomeAuthority)
        this.opts = {
            useLlm: opts.useLlm ?? true,
            model: opts.model,
            maxReplans: opts.maxReplans ?? Infinity,
            opencodeBin: opts.opencodeBin ?? "opencode",
            timeoutMs: opts.timeoutMs ?? 300_000,
            snapshot: opts.snapshot,
            resolveRoute: opts.resolveRoute,
            escalationRoute: opts.escalationRoute,
            runId: opts.runId,
            emitRecoveryDecisions: opts.emitRecoveryDecisions,
        }
    }

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
        if (this.sources.observeLease(source, event, this.leases, this.opts.runId)) return
        if (!this.sources.accepts(source, event)) return
        this.critiques.record(event)
        const failure = recoveryInput(event)
        if (!failure) return
        if (
            this.opts.emitRecoveryDecisions &&
            !this.leases.consumeResult(failure, this.opts.runId)
        ) return
        if (this.replansEmitted >= this.opts.maxReplans) {
            this.emitRecoveryDecision(failure, "abort", "replan budget exhausted")
            return
        }

        this.emitRecoveryStarted(failure)
        const evaluation = this.opts.useLlm
            ? ++this.evaluationSequence
            : null

        const work = (async () => {
            try {
                const replan = this.opts.useLlm
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
        if (!this.opts.emitRecoveryDecisions || !this.opts.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, RecoveryEvaluationStarted.create({
                runId: this.opts.runId,
                storyId: failure.storyId,
                source: "surgeon:opencode",
            }))
        }
    }

    private emitRecoveryDecision(
        failure: StoryResultData,
        action: "replan" | "abort",
        reason: string,
    ): void {
        if (!this.opts.emitRecoveryDecisions || !this.opts.runId) return
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, RecoveryDecision.create({
                runId: this.opts.runId,
                storyId: failure.storyId,
                source: "surgeon:opencode",
                action,
                reason,
            }))
        }
    }

    private async evaluateWithLlm(
        failure: StoryResultData,
        evaluation: number,
    ): Promise<ReplanData | null> {
        const snap = this.opts.snapshot()
        const userPrompt = buildSurgeonPrompt(
            snap,
            failure,
            this.opts.resolveRoute,
            this.opts.escalationRoute,
            this.critiques.forStory(failure.storyId),
        )
        const prompt = `${SURGEON_SYSTEM_PROMPT}\n\n${userPrompt}`

        try {
            const text = await runOpenCodeOneShot({
                prompt,
                cwd: process.cwd(),
                model: this.opts.model,
                opencodeBin: this.opts.opencodeBin,
                timeoutMs: this.opts.timeoutMs,
                label: "opencode-surgeon",
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

            const modifiedDeps: Record<string, readonly string[]> = {}
            for (const m of parsed.modifiedDeps ?? []) {
                if (typeof m.id === "string" && Array.isArray(m.newDependsOn)) {
                    modifiedDeps[m.id] = [...m.newDependsOn]
                }
            }
            return {
                source: "surgeon",
                reason: `${parsed.action}: ${parsed.reason ?? ""}`,
                addedStories: parsed.added ?? [],
                removedStoryIds: parsed.removed ?? [],
                modifiedDeps,
            }
        } catch (err) {
            // Fall back to deterministic so the run still has a chance
            // to recover.
            const fallback = surgeonDeterministicReplan(failure)
            return {
                ...fallback,
                reason: `${fallback.reason} (opencode fallback after error: ${(err as Error)?.message ?? String(err)})`,
            }
        }
    }

    private invocationObserver(
        failure: StoryResultData,
        evaluation: number,
    ): RunnerInvocationObserver {
        const runId = failure.runId ?? this.opts.runId ?? null
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
                        backend: "opencode",
                        requestedModel: this.opts.model ?? null,
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
