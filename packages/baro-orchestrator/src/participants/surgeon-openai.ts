/**
 * SurgeonOpenAI — sibling of `Surgeon` that runs the replan-reasoning
 * call through Mozaik 3.9's native OpenAI inference runner instead of
 * shelling out to `claude --print`.
 *
 * Same bus contract:
 *   - Observes `StoryResultItem` failures (`success === false`).
 *   - For each failure within the per-run `maxReplans` budget, asks
 *     the model for a structured replan (split/prereq/rewire/skip/abort).
 *   - Emits one `ReplanItem` per evaluation (or zero on "abort").
 *   - Falls back to the deterministic skip strategy on inference errors
 *     so a flaky LLM call doesn't strand the run.
 *
 * Wired via `OrchestrateConfig.llm === "openai"` in `orchestrate.ts`.
 * Default model: `gpt-5.5` — every OpenAI phase routes through 5.5 now.
 * Surgeon's reasoning load justifies the flagship even more than the
 * higher-frequency Critic does.
 */

import {
    BaseObserver,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    SemanticEvent,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
    type Participant,
} from "@mozaik-ai/core"

import {
    UsageAccumulator,
    runInferenceRound,
} from "../planning/openai-runtime.js"

import {
    Replan,
    type ReplanData,
    type ReplanStoryAdd,
    StoryResult,
    type StoryResultData,
} from "../semantic-events.js"
import {
    SURGEON_SYSTEM_PROMPT,
    buildSurgeonPrompt,
    extractJsonObject,
    surgeonDeterministicReplan,
    type PrdSnapshot,
} from "./surgeon.js"

export interface SurgeonOpenAIOptions {
    /** PRD snapshot provider. Same shape as `Surgeon`. */
    snapshot: () => PrdSnapshot
    /** Max replans this Surgeon will emit per run. Default: 10. */
    maxReplans?: number
    /**
     * OpenAI model name. One of `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
     * `gpt-5.4-nano`. Default: `gpt-5.5`.
     */
    model?: string
}

function pickModel(name: string): GenerativeModel {
    switch (name) {
        case "gpt-5.5":
            return new Gpt55()
        case "gpt-5.4":
            return new Gpt54()
        case "gpt-5.4-mini":
            return new Gpt54Mini()
        case "gpt-5.4-nano":
            return new Gpt54Nano()
        default:
            throw new Error(
                `SurgeonOpenAI: unknown model "${name}" — Mozaik 3.9 ships ` +
                `gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano`,
            )
    }
}

export class SurgeonOpenAI extends BaseObserver {
    private readonly opts: Required<Pick<SurgeonOpenAIOptions, "maxReplans" | "model">> &
        SurgeonOpenAIOptions
    private readonly model: GenerativeModel

    private replansEmitted = 0
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: SurgeonOpenAIOptions) {
        super()
        this.opts = {
            maxReplans: opts.maxReplans ?? 10,
            model: opts.model ?? "gpt-5.5",
            snapshot: opts.snapshot,
        }
        this.model = pickModel(this.opts.model)
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
            const replan = await this.evaluate(event.data)
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

    /**
     * One-shot OpenAI inference call asking the model for a structured
     * replan. Returns `null` on the "abort" action (no Replan event
     * emitted, run ends). Returns a deterministic-skip data shape on any
     * inference or JSON-parse error so the run still has a chance to
     * recover.
     */
    private async evaluate(failure: StoryResultData): Promise<ReplanData | null> {
        const snap = this.opts.snapshot()
        const userPrompt = buildSurgeonPrompt(snap, failure)
        const context = ModelContext.create("surgeon")
            .addContextItem(SystemMessageItem.create(SURGEON_SYSTEM_PROMPT))
            .addContextItem(UserMessageItem.create(userPrompt))

        try {
            const round = await runInferenceRound(context, this.model)
            const usage = new UsageAccumulator()
            usage.add(round.usage)
            let assistantText = ""
            for (const item of round.items) {
                if (item.type === "message") {
                    const json = item.toJSON() as { content: Array<{ text: string }> }
                    assistantText += json.content?.[0]?.text ?? ""
                }
            }
            if (!assistantText.trim()) {
                throw new Error("OpenAI returned empty assistant text")
            }
            process.stderr.write(`[surgeon-openai] ${usage.summary()}\n`)

            const verdictJson = extractJsonObject(assistantText)
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
            const fallback = surgeonDeterministicReplan(failure)
            return {
                ...fallback,
                reason: `${fallback.reason} (openai-llm fallback after error: ${(err as Error)?.message ?? String(err)})`,
            }
        }
    }
}
