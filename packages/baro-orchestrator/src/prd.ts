/**
 * PRD types and persistence. CONSTRAINT: must stay compatible with the
 * `prd.json` schema the planner produces (shared with the Rust side).
 */

import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"

import type {
    ReplanData,
    RuntimeReplanAppliedData,
} from "./semantic-events.js"
import { runtimeDecisionFingerprintMatches } from "./runtime/runtime-replan-fingerprint.js"

export interface PrdStory {
    id: string
    priority: number
    title: string
    description: string
    dependsOn: string[]
    retries: number
    acceptance: string[]
    tests: string[]
    passes: boolean
    completedAt: string | null
    durationSecs: number | null
    model?: string
}

/** Intake's (or the user's) execution-mode decision, stamped by run-planner. */
export interface PrdExecutionMode {
    mode: "focused" | "sequential" | "parallel"
    reason: string
    confidence?: number
    maxStories?: number
    parallelism?: number
    /** "user" (explicit pick) | "llm" (intake) | "heuristic" (fallback). */
    source?: string
}

export interface PrdFile {
    project: string
    branchName: string
    description: string
    userStories: PrdStory[]
    /**
     * Architect's DecisionDocument (file paths, schema shapes, naming).
     * Conductor prepends it verbatim to every story prompt so agents never
     * re-decide things upstream already pinned down.
     */
    decisionDocument?: string
    executionMode?: PrdExecutionMode
    /** Durable collective control-plane metadata. Planners may omit it. */
    runtimeGraph?: PrdRuntimeGraphState
}

export interface PrdRuntimeReplanDecision {
    fingerprint: string
    applied: RuntimeReplanAppliedData
}

export interface PrdRuntimeGraphState {
    runId: string
    version: number
    dynamicStories: number
    appliedDecisions: PrdRuntimeReplanDecision[]
}

const STORY_DEFAULTS: Pick<PrdStory, "retries"> = { retries: 2 }

export function loadPrd(path: string): PrdFile {
    const raw = readFileSync(path, "utf8")
    const json = JSON.parse(raw) as Partial<PrdFile>
    return normalizePrd(json, path)
}

export function savePrd(path: string, prd: PrdFile): void {
    writeFileSync(path, JSON.stringify(prd, null, 2) + "\n")
}

/**
 * Persist a complete PRD snapshot with atomic path replacement. Runtime graph
 * transactions use this so a process never observes `Applied` after a partial
 * truncate/write. The temporary file is removed on every failed path.
 */
export function savePrdAtomic(path: string, prd: PrdFile): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
        writeFileSync(temporary, JSON.stringify(prd, null, 2) + "\n", {
            flag: "wx",
        })
        renameSync(temporary, path)
    } catch (error) {
        try {
            unlinkSync(temporary)
        } catch {}
        throw error
    }
}

export function normalizePrd(input: Partial<PrdFile>, source: string): PrdFile {
    if (!input || typeof input !== "object") {
        throw new Error(`PRD at ${source} is not a JSON object`)
    }
    const project = typeof input.project === "string" ? input.project : ""
    // Strip a doubled "baro/baro/…" prefix HERE, not just in
    // createOrCheckoutBranch: the Finalizer opens the PR from prd.branchName
    // verbatim, and a doubled (empty) head makes `gh pr create` fail with
    // "No commits between…". One canonical name → checkout, push, PR agree.
    let branchName = typeof input.branchName === "string" ? input.branchName : ""
    while (branchName.startsWith("baro/baro/")) branchName = branchName.slice("baro/".length)
    const description = typeof input.description === "string" ? input.description : ""
    const stories = Array.isArray(input.userStories) ? input.userStories : []
    const decisionDocument =
        typeof input.decisionDocument === "string" && input.decisionDocument.trim().length > 0
            ? input.decisionDocument
            : undefined
    const executionMode =
        input.executionMode && typeof input.executionMode === "object" && typeof input.executionMode.mode === "string"
            ? input.executionMode
            : undefined
    const runtimeGraph = normalizeRuntimeGraph(input.runtimeGraph)
    return {
        project,
        branchName,
        description,
        userStories: stories.map((s, i) => normalizeStory(s, i, source)),
        decisionDocument,
        executionMode,
        ...(runtimeGraph ? { runtimeGraph } : {}),
    }
}

function normalizeRuntimeGraph(value: unknown): PrdRuntimeGraphState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const graph = value as Partial<PrdRuntimeGraphState>
    if (
        typeof graph.runId !== "string" ||
        !Number.isSafeInteger(graph.version) ||
        Number(graph.version) < 1 ||
        !Number.isSafeInteger(graph.dynamicStories) ||
        Number(graph.dynamicStories) < 0 ||
        !Array.isArray(graph.appliedDecisions)
    ) return undefined
    const validDecisions = graph.appliedDecisions
        .filter((decision) =>
            validRuntimeDecision(
                decision,
                graph.runId!,
                Number(graph.version),
            ),
        )
    const proposalCounts = new Map<string, number>()
    for (const decision of validDecisions) {
        const proposalId = decision.applied.proposalId
        proposalCounts.set(proposalId, (proposalCounts.get(proposalId) ?? 0) + 1)
    }
    const appliedDecisions = validDecisions
        .filter(
            (decision) =>
                proposalCounts.get(decision.applied.proposalId) === 1,
        )
        .slice(-32)
        .map((decision) => structuredClone(decision))
    return {
        runId: graph.runId,
        version: Number(graph.version),
        dynamicStories: Number(graph.dynamicStories),
        appliedDecisions,
    }
}

function validRuntimeDecision(
    value: unknown,
    durableRunId: string,
    durableVersion: number,
): value is PrdRuntimeReplanDecision {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const decision = value as Partial<PrdRuntimeReplanDecision>
    const applied = decision.applied as Partial<RuntimeReplanAppliedData> | undefined
    return (
        typeof decision.fingerprint === "string" &&
        decision.fingerprint.length > 0 &&
        !!applied &&
        applied.runId === durableRunId &&
        nonBlank(applied.proposalId) &&
        nonBlank(applied.sourceStoryId) &&
        nonBlank(applied.leaseId) &&
        safeIntegerAtLeast(applied.generation, 0) &&
        safeIntegerAtLeast(applied.baseGraphVersion, 1) &&
        applied.baseGraphVersion === applied.previousGraphVersion &&
        applied.graphVersion === Number(applied.previousGraphVersion) + 1 &&
        Number(applied.graphVersion) <= durableVersion &&
        (applied.currentGraphVersion === undefined ||
            (safeIntegerAtLeast(applied.currentGraphVersion, applied.graphVersion!) &&
                Number(applied.currentGraphVersion) <= durableVersion)) &&
        nonBlank(applied.reason) &&
        validStoredRuntimeMutation(applied.mutation) &&
        runtimeDecisionFingerprintMatches(
            decision as PrdRuntimeReplanDecision,
        )
    )
}

function validStoredRuntimeMutation(value: unknown): boolean {
    if (!plainRecord(value)) return false
    if (!onlyKeys(value, ["addedStories", "removedStoryIds", "modifiedDeps"])) {
        return false
    }
    if (
        !Array.isArray(value.addedStories) ||
        !value.addedStories.every(validStoredRuntimeStory) ||
        !stringArrayValue(value.removedStoryIds) ||
        !plainRecord(value.modifiedDeps) ||
        !Object.values(value.modifiedDeps).every(stringArrayValue)
    ) return false
    return true
}

function validStoredRuntimeStory(value: unknown): boolean {
    if (!plainRecord(value)) return false
    if (
        !onlyKeys(value, [
            "id",
            "priority",
            "title",
            "description",
            "dependsOn",
            "retries",
            "acceptance",
            "tests",
            "model",
        ])
    ) return false
    return (
        nonBlank(value.id) &&
        typeof value.priority === "number" &&
        Number.isFinite(value.priority) &&
        nonBlank(value.title) &&
        nonBlank(value.description) &&
        stringArrayValue(value.dependsOn) &&
        (value.retries === undefined || safeIntegerAtLeast(value.retries, 0)) &&
        (value.acceptance === undefined || stringArrayValue(value.acceptance)) &&
        (value.tests === undefined || stringArrayValue(value.tests)) &&
        (value.model === undefined || nonBlank(value.model))
    )
}

function safeIntegerAtLeast(value: unknown, minimum: number): boolean {
    return Number.isSafeInteger(value) && Number(value) >= minimum
}

function nonBlank(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function stringArrayValue(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function plainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

function onlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const keys = new Set(allowed)
    return Object.keys(value).every((key) => keys.has(key))
}

function normalizeStory(
    input: Partial<PrdStory>,
    index: number,
    source: string,
): PrdStory {
    if (!input || typeof input !== "object") {
        throw new Error(`PRD story ${index} in ${source} is not an object`)
    }
    const id = typeof input.id === "string" ? input.id : `S${index + 1}`
    const priority = typeof input.priority === "number" ? input.priority : 0
    const title = typeof input.title === "string" ? input.title : ""
    const description =
        typeof input.description === "string" ? input.description : ""
    const dependsOn = Array.isArray(input.dependsOn)
        ? input.dependsOn.filter((d): d is string => typeof d === "string")
        : []
    const retries =
        typeof input.retries === "number" && Number.isFinite(input.retries)
            ? Math.max(0, Math.floor(input.retries))
            : STORY_DEFAULTS.retries
    const acceptance = Array.isArray(input.acceptance)
        ? input.acceptance.filter((a): a is string => typeof a === "string")
        : []
    const tests = Array.isArray(input.tests)
        ? input.tests.filter((t): t is string => typeof t === "string")
        : []
    const passes = input.passes === true
    const completedAt =
        typeof input.completedAt === "string" ? input.completedAt : null
    const durationSecs =
        typeof input.durationSecs === "number" ? input.durationSecs : null
    const model = typeof input.model === "string" ? input.model : undefined
    return {
        id,
        priority,
        title,
        description,
        dependsOn,
        retries,
        acceptance,
        tests,
        passes,
        completedAt,
        durationSecs,
        model,
    }
}

/** Immutable update; caller is responsible for persisting. */
export function markStoryPassed(
    prd: PrdFile,
    storyId: string,
    durationSecs: number,
): PrdFile {
    return {
        ...prd,
        userStories: prd.userStories.map((s) =>
            s.id === storyId
                ? {
                      ...s,
                      passes: true,
                      completedAt: new Date().toISOString(),
                      durationSecs,
                  }
                : s,
        ),
    }
}

/** Apply a replan without mutating the current PRD snapshot. */
export function applyReplan(prd: PrdFile, replan: ReplanData): PrdFile {
    let stories = prd.userStories.slice()

    if (replan.removedStoryIds.length > 0) {
        const removeSet = new Set(replan.removedStoryIds)
        stories = stories.filter((story) => !removeSet.has(story.id) || story.passes)
    }

    if (Object.keys(replan.modifiedDeps).length > 0) {
        stories = stories.map((story) => {
            const dependsOn = replan.modifiedDeps[story.id]
            return dependsOn ? { ...story, dependsOn: [...dependsOn] } : story
        })
    }

    if (replan.addedStories.length > 0) {
        const existing = new Set(stories.map((story) => story.id))
        for (const added of replan.addedStories) {
            if (existing.has(added.id)) continue
            existing.add(added.id)
            stories.push({
                id: added.id,
                priority: added.priority,
                title: added.title,
                description: added.description,
                dependsOn: [...added.dependsOn],
                retries: added.retries ?? 2,
                acceptance: added.acceptance ? [...added.acceptance] : [],
                tests: added.tests ? [...added.tests] : [],
                passes: false,
                completedAt: null,
                durationSecs: null,
                model: added.model,
            })
        }
    }

    return { ...prd, userStories: stories }
}

/**
 * Trailer for every story commit and PR body (so squash-merges inherit it).
 * The `<numericUserId>+<login>@users.noreply.github.com` shape is what makes
 * GitHub auto-attribute commits to @baro-rs in the contributors view.
 */
export const BARO_COAUTHOR_TRAILER =
    "Co-Authored-By: baro <285254893+baro-rs@users.noreply.github.com>"

/**
 * Fallback prompt — callers should prefer a project-local `prompt.md`
 * template when one exists.
 */
export function buildDefaultStoryPrompt(story: PrdStory): string {
    const acceptance = story.acceptance.length
        ? story.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")
        : "(none specified)"
    const tests = story.tests.length
        ? story.tests.map((t) => `- ${t}`).join("\n")
        : "(no test commands specified)"
    return [
        `You are working on story ${story.id}: ${story.title}`,
        "",
        story.description,
        "",
        "ACCEPTANCE CRITERIA:",
        acceptance,
        "",
        "TEST COMMANDS:",
        tests,
        "",
        "SCOPE DISCIPLINE (read this twice):",
        "- Do ONLY what this story's description and acceptance criteria require. Nothing else.",
        "- Do NOT refactor adjacent code, rename neighbouring symbols, tidy unrelated files,",
        "  reformat imports, or fix issues you happen to notice along the way. Those are",
        "  separate stories the user did not ask for.",
        "- Do NOT add new tests unless an acceptance criterion explicitly asks for one.",
        "- Do NOT introduce new dependencies, new abstractions, or new configuration",
        "  unless this story's description names them.",
        "- If a single-file edit is sufficient, make a single-file edit. Resist expanding.",
        "- If you notice unrelated bugs or improvements, mention them in your final commit",
        "  message under a `Noted (out of scope):` line so the user can file follow-ups.",
        "- Do NOT take external side-effecting actions — opening GitHub issues, posting PR",
        "  comments, sending notifications, pushing tags — UNLESS this story's acceptance",
        "  criteria explicitly require it. In a parallel run many agents share one working",
        "  tree, so a failure you observe is very likely produced by another story, not you.",
        "- If `npm test` / `cargo test` / the build surfaces a FAILURE in a file this story",
        "  did not create or modify, it is not yours to fix OR report. Note it under",
        "  `Noted (out of scope):` and move on — do not open an issue for it. A dedicated",
        "  triage story (or the user) owns deciding whether a shared failure is a real bug.",
        "- If — and ONLY if — this story's acceptance criteria explicitly require you to open",
        "  a GitHub issue, you MUST dedup BEFORE creating: run",
        '  `gh issue list --state open --search "<key symptom / file:line>"` and read the',
        "  titles it returns. If an open issue already describes the same root cause, do NOT",
        "  create a second one — at most add a comment to the existing issue if you have new",
        "  information. Only run `gh issue create` when no open issue matches. Give every issue",
        "  you do create a specific, deterministic title (name the file and the symptom, e.g.",
        '  "GetShopsQueryFilter: numeric city throws in @Transform") so a later run or a',
        "  sibling agent can match it and skip. This holds even when several stories are each",
        "  told to file issues — the search-then-create check is what prevents duplicates.",
        "",
        "IMPORTANT: Before you commit, you MUST verify the project builds successfully:",
        "  - If Cargo.toml exists: run `cargo build` and fix all errors and warnings",
        "  - If package.json exists: run `npm run build` (if a build script exists) and fix errors",
        "  - If go.mod exists: run `go build ./...` and fix errors",
        "  - If pyproject.toml or requirements.txt: ensure code is import-clean",
        "  - Otherwise: ensure linting/typecheck passes",
        "",
        "When done with the story, commit your changes with a clear message.",
        "",
        "COMMIT MESSAGE TRAILER (mandatory):",
        "Every commit you create as part of this story MUST end with a blank line",
        "followed by this exact trailer line — no edits, no surrounding text:",
        "",
        `    ${BARO_COAUTHOR_TRAILER}`,
        "",
        "Use `git commit -m \"…\" -m \"\" -m \"" + BARO_COAUTHOR_TRAILER + "\"` so the",
        "trailer lands on its own paragraph at the bottom (git collapses the empty",
        "middle `-m` to a blank line between the subject and the trailer). This",
        "attributes the commit to the baro account in the contributors view.",
    ].join("\n")
}
