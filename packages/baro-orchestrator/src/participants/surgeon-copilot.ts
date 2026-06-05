/**
 * SurgeonCopilot — adaptive DAG mutation via `copilot -p --output-format json`.
 * Sibling of `surgeon.ts` (Claude), `surgeon-openai.ts` (OpenAI API), and
 * `surgeon-codex.ts` (Codex CLI).
 *
 * Same bus contract as the Claude variant: observes terminal story
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

import { runCopilotOneShot } from "../copilot-one-shot.js"
import {
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    StoryResult,
    type StoryResultData,
} from "../semantic-events.js"
import {
    PrdSnapshot,
    SURGEON_SYSTEM_PROMPT,
    buildSurgeonPrompt,
    extractJsonObject,
    surgeonDeterministicReplan,
} from "./surgeon.js"

export interface SurgeonCopilotOptions {
    /** Returns a fresh snapshot of the current PRD. */
    snapshot: () => PrdSnapshot
    /** Use Copilot CLI to evaluate replans. Default: true. */
    useLlm?: boolean
    /** Model for LLM evaluations. Default: undefined (Copilot picks). */
    model?: string
    /** Raw baro effort value; clamped to Copilot's low|medium|high. */
    effort?: string
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /** Path to the `copilot` binary. Default: "copilot". */
    copilotBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 300_000 (5 min). */
    timeoutMs?: number
}

export class SurgeonCopilot extends BaseObserver {
    private readonly opts: Required<
        Omit<
            SurgeonCopilotOptions,
            "snapshot" | "model" | "effort" | "copilotBin"
        >
    > & {
        snapshot: () => PrdSnapshot
        model: string | undefined
        effort: string | undefined
        copilotBin: string
    }

    private replansEmitted = 0
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: SurgeonCopilotOptions) {
        super()
        this.opts = {
            useLlm: opts.useLlm ?? true,
            model: opts.model,
            effort: opts.effort,
            maxReplans: opts.maxReplans ?? 10,
            copilotBin: opts.copilotBin ?? "copilot",
            timeoutMs: opts.timeoutMs ?? 300_000,
            snapshot: opts.snapshot,
        }
    }

    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
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
        const userPrompt = buildSurgeonPrompt(snap, failure)
        const prompt = `${SURGEON_SYSTEM_PROMPT}\n\n${userPrompt}`

        try {
            const text = await runCopilotOneShot({
                prompt,
                cwd: process.cwd(),
                model: this.opts.model,
                effort: this.opts.effort,
                copilotBin: this.opts.copilotBin,
                timeoutMs: this.opts.timeoutMs,
                label: "copilot-surgeon",
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
                reason: `${fallback.reason} (copilot fallback after error: ${(err as Error)?.message ?? String(err)})`,
            }
        }
    }
}
