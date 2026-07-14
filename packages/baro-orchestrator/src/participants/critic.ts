/**
 * Critic — live acceptance-criteria evaluator.
 *
 * Observes AgentResultItem events on the bus. For each watched agent that
 * completes a turn without error, the Critic spawns a short-lived
 * `claude --print --model <haiku-default>` subprocess to ask whether the
 * output satisfies the agent's acceptance criteria.
 *
 * The verdict is *always* published as a CritiqueItem (audit trail). On
 * "fail", an AgentTargetedMessageItem is emitted back to the agent as its
 * next conversational turn — up to `maxEmissionsPerAgent` times, after which
 * corrective messages are suppressed but CritiqueItem-s keep accumulating.
 *
 * Architectural note: Critic uses the Claude CLI subprocess (same auth path
 * as every other agent in this system). It does NOT call the Anthropic SDK
 * directly because that would fragment the auth model — Claude Code runs
 * via OAuth session, not via ANTHROPIC_API_KEY. The CLI subprocess inherits
 * whatever auth `claude` is configured with, so Critic just works wherever
 * `claude` does.
 *
 * Library-grade: no imports from prd.ts, story-agent.ts, or conductor.ts.
 */

import { execFileCli } from "../exec-file-cli.js"

import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    AgentResult,
    AgentTargetedMessage,
    Critique,
} from "../semantic-events.js"

export const VERDICT_SYSTEM_PROMPT = `\
You are a strict acceptance-criteria evaluator. You will receive:
1. A list of acceptance criteria that must ALL be satisfied.
2. The output text produced by an agent.

Evaluate whether every criterion is fully satisfied by the output.
Respond ONLY with a JSON object — no prose, no markdown fences — in exactly this shape:
{"verdict":"pass","reasoning":"…","violated_criteria":[]}
or
{"verdict":"fail","reasoning":"…","violated_criteria":["criterion A","criterion B"]}

Rules:
- "verdict" must be "pass" or "fail".
- "reasoning" must be a concise explanation (≤ 200 words).
- "violated_criteria" must list the exact criterion strings that are NOT satisfied.
- If ALL criteria pass, "violated_criteria" must be an empty array.
- Do NOT include any text outside the JSON object.`

export interface CriticOptions {
    /** Map from agentId to its acceptance-criteria strings. */
    targets: ReadonlyMap<string, readonly string[]>
    /** Max corrective AgentTargetedMessageItem-s per agent. Default: 2. */
    maxEmissionsPerAgent?: number
    /** Claude model used for verdict calls. Default: "haiku". */
    model?: string
    /** Path to the `claude` binary. Default: "claude" (resolved via PATH). */
    claudeBin?: string
    /** Per-evaluation timeout in milliseconds. Default: 60_000. */
    timeoutMs?: number
}

export class Critic extends BaseObserver {
    private readonly opts: Required<CriticOptions>
    /** agentId → number of AgentTargetedMessageItem-s emitted so far. */
    private readonly emissions = new Map<string, number>()
    /** agentId → number of result turns seen (for CritiqueItem.turn). */
    private readonly turnCount = new Map<string, number>()
    /**
     * Critic's evaluate() spawns an async `claude --print` subprocess.
     * Mozaik's deliverContextItem fan-out doesn't await onContextItem's
     * returned promise, so we track in-flight evaluations here and let
     * callers (e.g. orchestrate()) await `idle()` before tearing down.
     */
    private readonly pending = new Set<Promise<void>>()

    constructor(opts: CriticOptions) {
        super()
        this.opts = {
            maxEmissionsPerAgent: opts.maxEmissionsPerAgent ?? 2,
            model: opts.model ?? "haiku",
            claudeBin: opts.claudeBin ?? "claude",
            timeoutMs: opts.timeoutMs ?? 60_000,
            targets: opts.targets,
        }
    }

    /** Resolves once every in-flight evaluation has emitted its CritiqueItem. */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.pending])
    }

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (!AgentResult.is(event)) return
        const { agentId, isError, resultText } = event.data
        if (isError || !resultText) return

        const criteria = this.opts.targets.get(agentId)
        if (!criteria || criteria.length === 0) return

        const turn = (this.turnCount.get(agentId) ?? 0) + 1
        this.turnCount.set(agentId, turn)

        const work = (async () => {
            const { verdict, reasoning, violatedCriteria } = await this.evaluate(
                resultText,
                criteria,
            )

            // Always emit audit trail.
            const critiqueEvent = Critique.create({
                agentId,
                verdict,
                reasoning,
                violatedCriteria,
                turn,
                modelUsed: this.opts.model,
            })
            for (const env of this.getEnvironments()) {
                env.deliverSemanticEvent(this, critiqueEvent)
            }

            // Emit corrective message only on fail and under the per-agent cap.
            if (verdict === "fail") {
                const emitted = this.emissions.get(agentId) ?? 0
                if (emitted < this.opts.maxEmissionsPerAgent) {
                    this.emissions.set(agentId, emitted + 1)
                    const text = buildCorrectiveMessage(reasoning, violatedCriteria)
                    const msg = AgentTargetedMessage.create({
                        recipientId: agentId,
                        text,
                        metadata: {
                            criticTurn: turn,
                            emissionIndex: emitted + 1,
                        },
                    })
                    for (const env of this.getEnvironments()) {
                        env.deliverSemanticEvent(this, msg)
                    }
                }
            }
        })()

        this.pending.add(work)
        work.finally(() => {
            this.pending.delete(work)
        })

        await work
    }

    private async evaluate(
        resultText: string,
        criteria: readonly string[],
    ): Promise<{
        verdict: "pass" | "fail"
        reasoning: string
        violatedCriteria: string[]
    }> {
        const prompt = buildEvalPrompt(criteria, resultText)

        try {
            const { stdout } = await execFileCli(
                this.opts.claudeBin,
                [
                    "--print",
                    "--output-format",
                    "json",
                    "--model",
                    this.opts.model,
                    "--permission-mode",
                    "bypassPermissions",
                    "--system-prompt",
                    VERDICT_SYSTEM_PROMPT,
                    "-p",
                    prompt,
                ],
                {
                    timeout: this.opts.timeoutMs,
                    maxBuffer: 4 * 1024 * 1024,
                },
            )

            // `claude --output-format json` returns one JSON object on stdout
            // with a `result` field containing the assistant's text answer
            // (per packages/baro-app/scripts/SPIKE-FINDINGS.md).
            const wrapper = JSON.parse(stdout) as { result?: string }
            const verdictText =
                typeof wrapper.result === "string" ? wrapper.result.trim() : ""
            if (!verdictText) {
                throw new Error("claude returned empty result")
            }

            const verdictJson = extractVerdictJson(verdictText)
            const parsed = JSON.parse(verdictJson) as {
                verdict: "pass" | "fail"
                reasoning: string
                violated_criteria: string[]
            }

            return {
                verdict: parsed.verdict === "pass" ? "pass" : "fail",
                reasoning: parsed.reasoning ?? "",
                violatedCriteria: Array.isArray(parsed.violated_criteria)
                    ? parsed.violated_criteria
                    : [],
            }
        } catch (err) {
            return {
                verdict: "fail",
                reasoning: `Critic LLM call failed: ${String((err as Error)?.message ?? err)}`,
                violatedCriteria: ["[critic error — could not evaluate]"],
            }
        }
    }
}

export function buildEvalPrompt(
    criteria: readonly string[],
    resultText: string,
): string {
    const criteriaList = criteria
        .map((c, i) => `${i + 1}. ${c}`)
        .join("\n")
    return [
        "## Acceptance criteria",
        criteriaList,
        "",
        "## Agent output",
        resultText,
    ].join("\n")
}

export function buildCorrectiveMessage(
    reasoning: string,
    violatedCriteria: string[],
): string {
    const lines: string[] = [
        "Your output did not satisfy all acceptance criteria. Please revise.",
        "",
        `**Reasoning:** ${reasoning}`,
    ]
    if (violatedCriteria.length > 0) {
        lines.push("", "**Violated criteria:**")
        for (const c of violatedCriteria) {
            lines.push(`- ${c}`)
        }
    }
    lines.push("", "Please address the above and resubmit your work.")
    return lines.join("\n")
}

/**
 * Claude's response to the verdict prompt should be just the JSON object,
 * but the model occasionally wraps it in a markdown fence or adds a
 * leading/trailing sentence even with strict instructions. Tolerate that
 * by extracting the first balanced `{...}` block.
 */
export function extractVerdictJson(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return trimmed
    }
    const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fenceMatch) {
        return fenceMatch[1]!
    }
    const start = trimmed.indexOf("{")
    if (start < 0) {
        throw new Error(`no JSON object found in critic response: ${trimmed.slice(0, 200)}`)
    }
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth += 1
        else if (ch === "}") {
            depth -= 1
            if (depth === 0) {
                return trimmed.slice(start, i + 1)
            }
        }
    }
    throw new Error(`unbalanced JSON object in critic response: ${trimmed.slice(0, 200)}`)
}
