/**
 * The intake contract is ENFORCED here, not just suggested in the planner
 * prompt: a focused run is collapsed to exactly one story, maxStories is a
 * hard cap (tail-trim in priority order, dependents of trimmed stories
 * trimmed too), and the decision is stamped into the PRD (`executionMode`)
 * so the orchestrator can cap parallelism and the TUI/dashboard can show
 * what was decided.
 */

import type { PrdExecutionMode, PrdFile, PrdStory } from "../prd.js"
import type { ModeContract } from "./planner-prompts.js"

/**
 * Concurrency follows the DAG — a level's stories are independent by
 * construction, so they run in parallel up to `configParallel` (0 = unlimited,
 * hosted sends ~10). Only a DELIBERATE choice serializes: `focused` (single-fix
 * mode), or a USER-picked `sequential` (caution the DAG can't see). An AUTO
 * `sequential` (intake's llm/heuristic guess) must NOT override the planner's DAG.
 */
export function resolveEffectiveParallel(mode: PrdExecutionMode | undefined, configParallel: number | undefined): number {
    const forcedSerial = mode?.mode === "focused" || (mode?.mode === "sequential" && mode.source === "user")
    return forcedSerial ? 1 : (configParallel ?? 0)
}

export function enforceModeContract(prdJson: string, contract: ModeContract, goal: string): string {
    let prd: Partial<PrdFile>
    try {
        prd = JSON.parse(prdJson) as Partial<PrdFile>
    } catch {
        return prdJson // invalid JSON fails downstream with a better error
    }
    if (!Array.isArray(prd.userStories)) return prdJson
    let stories = prd.userStories as PrdStory[]

    if (contract.mode === "focused" && stories.length > 1) {
        process.stderr.write(
            `[run-planner] contract violation: focused mode but planner emitted ${stories.length} stories — collapsing to one\n`,
        )
        const first = stories[0]!
        const steps = stories
            .map((s) => `- ${s.title}${s.description ? `: ${s.description}` : ""}`)
            .join("\n")
        stories = [
            {
                ...first,
                id: "S1",
                priority: 1,
                title: first.title,
                description: `${goal.trim()}\n\nImplement all of the following as ONE coherent change:\n${steps}`,
                dependsOn: [],
                acceptance: [...new Set(stories.flatMap((s) => s.acceptance ?? []))],
                tests: [...new Set(stories.flatMap((s) => s.tests ?? []))],
                model: first.model ?? "heavy",
            },
        ]
    } else if (contract.maxStories && stories.length > contract.maxStories) {
        process.stderr.write(
            `[run-planner] contract violation: ${stories.length} stories > maxStories=${contract.maxStories} — trimming\n`,
        )
        const kept: PrdStory[] = []
        const keptIds = new Set<string>()
        for (const s of [...stories].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))) {
            if (kept.length >= contract.maxStories) break
            if ((s.dependsOn ?? []).every((d) => keptIds.has(d))) {
                kept.push(s)
                keptIds.add(s.id)
            }
        }
        if (kept.length > 0) stories = kept
    }

    prd.userStories = stories
    prd.executionMode = {
        mode: contract.mode,
        reason: contract.reason,
        confidence: contract.confidence,
        maxStories: contract.maxStories,
        parallelism: contract.parallelism,
        source: contract.source ?? "contract",
    }
    return JSON.stringify(prd)
}
