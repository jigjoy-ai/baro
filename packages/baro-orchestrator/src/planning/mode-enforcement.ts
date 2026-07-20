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
import { pruneVerificationOnlyStories } from "./verification-stories.js"

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

    const pruned = pruneVerificationOnlyStories(stories)
    stories = pruned.stories
    if (pruned.removedIds.length > 0) {
        process.stderr.write(
            `[run-planner] removed verification-only stories handled by RunVerifier: ${pruned.removedIds.join(", ")}\n`,
        )
    }
    if (stories.length === 0) {
        throw new Error(
            "planner produced only deterministic verification stories; final test/build/lint gates belong to RunVerifier",
        )
    }

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
                goalInvariantIds: [
                    ...new Set(
                        stories.flatMap((s) => s.goalInvariantIds ?? []),
                    ),
                ],
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

    // A parallel stamp on a one-story or fully serial plan is actively
    // misleading: the collective market will expose one offer, route the whole
    // goal to one (usually heavy) worker, and look healthy while doing no
    // decomposition at all. This is especially dangerous when a provider
    // returned malformed output and the planner substituted its one-story
    // fallback. Fail before execution instead of silently burning the worker
    // budget on a plan that contradicts the selected run shape.
    if (contract.mode === "parallel") {
        const width = widestDagLevel(stories)
        if (stories.length < 2 || width < 2) {
            throw new Error(
                `parallel mode requires at least one DAG level with 2 independent stories; ` +
                `planner produced ${stories.length} stor${stories.length === 1 ? "y" : "ies"} ` +
                `with maximum width ${width}. Refusing single-worker fallback.`,
            )
        }
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

/** Return the widest executable DAG level, rejecting malformed dependency graphs. */
export function widestDagLevel(stories: readonly PrdStory[]): number {
    const byId = new Map<string, PrdStory>()
    for (const story of stories) {
        if (!story.id || byId.has(story.id)) {
            throw new Error(`invalid planner DAG: duplicate or empty story id '${story.id ?? ""}'`)
        }
        byId.set(story.id, story)
    }
    for (const story of stories) {
        for (const dependency of story.dependsOn ?? []) {
            if (!byId.has(dependency)) {
                throw new Error(
                    `invalid planner DAG: story '${story.id}' depends on unknown story '${dependency}'`,
                )
            }
        }
    }

    const completed = new Set<string>()
    let widest = 0
    while (completed.size < stories.length) {
        const level = stories.filter(
            (story) =>
                !completed.has(story.id) &&
                (story.dependsOn ?? []).every((dependency) => completed.has(dependency)),
        )
        if (level.length === 0) {
            throw new Error("invalid planner DAG: dependency cycle detected")
        }
        widest = Math.max(widest, level.length)
        for (const story of level) completed.add(story.id)
    }
    return widest
}
