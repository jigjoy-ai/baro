/**
 * SurgeonPi — adaptive DAG mutation via the `pi` CLI.
 * Sibling of `surgeon.ts` (Claude), `surgeon-openai.ts` (OpenAI API),
 * `surgeon-codex.ts` (Codex CLI), and `surgeon-opencode.ts` (OpenCode CLI).
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

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import { runPiOneShot } from "../pi-one-shot.js"
import {
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    StoryResult,
    type StoryResultData,
} from "../semantic-events.js"
import {
    PrdSnapshot,
    type RouteDescriber,
    SURGEON_SYSTEM_PROMPT,
    buildSurgeonPrompt,
    CritiqueLog,
    extractJsonObject,
    surgeonDeterministicReplan,
} from "./surgeon.js"

export interface SurgeonPiOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Describes the model a story actually ran on (issue #48). */
    resolveRoute?: RouteDescriber
    /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
    escalationRoute?: string
    /** Use Pi CLI to evaluate replans. Default: true. */
    useLlm?: boolean
    /**
     * Provider to use (e.g. "anthropic", "openai"). Omit to use Pi's
     * configured default.
     */
    provider?: string
    /**
     * Model identifier. Omit to use Pi's configured default.
     */
    model?: string
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /** Path to the `pi` binary. Default: "pi". */
    piBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 300_000 (5 min). */
    timeoutMs?: number
}

export class SurgeonPi extends BaseObserver {
    private readonly opts: Required<
        Omit<SurgeonPiOptions, "snapshot" | "provider" | "model" | "piBin" | "resolveRoute" | "escalationRoute">
    > & {
        snapshot: () => PrdSnapshot
        provider: string | undefined
        model: string | undefined
        piBin: string
        resolveRoute?: RouteDescriber
        /** Explicit `backend:model` the Surgeon may set to escalate a stuck, right-sized story. */
        escalationRoute?: string
    }

    private replansEmitted = 0
    private readonly critiques = new CritiqueLog()
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: SurgeonPiOptions) {
        super()
        this.opts = {
            useLlm: opts.useLlm ?? true,
            provider: opts.provider,
            model: opts.model,
            maxReplans: opts.maxReplans ?? Infinity,
            piBin: opts.piBin ?? "pi",
            timeoutMs: opts.timeoutMs ?? 300_000,
            snapshot: opts.snapshot,
            resolveRoute: opts.resolveRoute,
            escalationRoute: opts.escalationRoute,
        }
    }

    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        this.critiques.record(event)
        if (!StoryResult.is(event)) return
        if (event.data.success) return
        if (this.replansEmitted >= this.opts.maxReplans) return

        const work = (async () => {
            const replan = this.opts.useLlm
                ? await this.evaluateWithLlm(event.data)
                : surgeonDeterministicReplan(event.data)
            if (!replan) return
            this.replansEmitted += 1
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, Replan.create(replan))
            }
        })()

        this.pending.add(work)
        work.finally(() => this.pending.delete(work))
        await work
    }

    private async evaluateWithLlm(
        failure: StoryResultData,
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
            const text = await runPiOneShot({
                prompt,
                cwd: process.cwd(),
                provider: this.opts.provider,
                model: this.opts.model,
                piBin: this.opts.piBin,
                timeoutMs: this.opts.timeoutMs,
                label: "pi-surgeon",
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
            // Validate LLM-supplied added/removed before they reach the
            // Conductor's DAG mutation. The `as ReplanStoryAdd[]` cast does
            // not enforce shape at runtime — a malformed entry (missing
            // dependsOn, non-string removal id) would otherwise be injected
            // into the DAG and crash a later `dependsOn` access or silently
            // mis-target a removal. Same element-by-element discipline as
            // modifiedDeps above.
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
                reason: `${fallback.reason} (pi fallback after error: ${(err as Error)?.message ?? String(err)})`,
            }
        }
    }
}
