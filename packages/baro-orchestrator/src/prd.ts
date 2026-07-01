/**
 * PRD types and persistence — compatible with the existing baro
 * `prd.json` schema produced by the planner. Mirrors the Rust types in
 * the original executor.rs so v1 plans drop into v2 without conversion.
 */

import { readFileSync, writeFileSync } from "fs"

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

export interface PrdFile {
    project: string
    branchName: string
    description: string
    userStories: PrdStory[]
    /**
     * Architect's DecisionDocument captured during the planning phase
     * (Rust side). Authoritative spec for every Story Agent: file
     * paths, schema/API shapes, naming conventions, dependency
     * choices. Conductor prepends this verbatim to every story prompt
     * so agents never re-decide things upstream already pinned down.
     */
    decisionDocument?: string
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

export function normalizePrd(input: Partial<PrdFile>, source: string): PrdFile {
    if (!input || typeof input !== "object") {
        throw new Error(`PRD at ${source} is not a JSON object`)
    }
    const project = typeof input.project === "string" ? input.project : ""
    // Strip an accidental doubled "baro/baro/…" prefix (a follow-up run on an
    // already baro-prefixed branch can double it). createOrCheckoutBranch strips
    // it before pushing, but the Finalizer opens the PR from prd.branchName
    // verbatim — so without normalizing HERE the PR head points at the doubled
    // (empty) branch and `gh pr create` fails with "No commits between…". One
    // canonical name → checkout, push, and PR all agree.
    let branchName = typeof input.branchName === "string" ? input.branchName : ""
    while (branchName.startsWith("baro/baro/")) branchName = branchName.slice("baro/".length)
    const description = typeof input.description === "string" ? input.description : ""
    const stories = Array.isArray(input.userStories) ? input.userStories : []
    const decisionDocument =
        typeof input.decisionDocument === "string" && input.decisionDocument.trim().length > 0
            ? input.decisionDocument
            : undefined
    return {
        project,
        branchName,
        description,
        userStories: stories.map((s, i) => normalizeStory(s, i, source)),
        decisionDocument,
    }
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

/**
 * Mark a story as passing and stamp completion metadata. Returns a new
 * PrdFile (immutable update); caller is responsible for persisting.
 */
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

/**
 * Co-author trailer baro asks every story-side commit to carry, and
 * that Finalizer drops at the bottom of every PR body so squash-merge
 * commits inherit it too. Format is GitHub's canonical noreply email
 * shape: `<numericUserId>+<login>@users.noreply.github.com`, which
 * makes GitHub auto-attribute the commit to the @baro-rs account in
 * the contributors view.
 *
 * Mirrors the Claude Code pattern (`Co-Authored-By: Claude … <noreply@
 * anthropic.com>`): humans stay primary author; the bot is the
 * co-author.
 */
export const BARO_COAUTHOR_TRAILER =
    "Co-Authored-By: baro <285254893+baro-rs@users.noreply.github.com>"

/**
 * Build the default story prompt from a PrdStory. Mirrors the inline
 * template fallback in baro's executor.rs `build_prompt`. If the project
 * directory contains a `prompt.md` template, callers should use that
 * instead — see `loadPromptTemplate`.
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
