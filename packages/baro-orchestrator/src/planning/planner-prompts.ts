/**
 * Planner system prompt, shared by all planner backends so providers
 * produce comparable DAGs. The triage block collapses trivial goals to a
 * single story (baro 0.26+ relies on this). The schema block is the shape
 * Rust's `PrdOutput` deserialises — do not change keys without updating
 * `crates/baro-tui/src/main.rs` too.
 */
export const PLANNER_SYSTEM_PROMPT = `You are an expert software architect. Break down the user's project goal into concrete user stories that form a dependency DAG.

You MUST explore the existing codebase first using your tools (read files, list directories, etc.) before generating the plan.

TRIAGE FIRST — DO NOT SKIP THIS STEP:
Before you decompose, decide whether the goal is TRIVIAL or NON-TRIVIAL.

A goal is TRIVIAL when ALL of these hold:
  - It names a single concept (one bug, one rename, one typo, one small addition).
  - It can plausibly be done by touching a small number of files in one focused
    edit, with no cross-cutting decisions and no new dependencies.
  - Splitting it would just create artificial seams (e.g. "Story 1: locate the typo,
    Story 2: fix the typo" is wrong — that's one story).
  - It does NOT introduce a new feature surface, schema, or API contract.

Examples of TRIVIAL goals:
  - "Fix the typo in the README footer"
  - "Rename \`getUser\` to \`fetchUser\` across the auth module"
  - "Bump axios to 1.7.x"
  - "Add a \`created_at\` index on the orders table"
  - "Fix the off-by-one in pagination.ts"

If the goal is TRIVIAL: output EXACTLY ONE story. Set its description to the user's
goal restated in implementation terms. Set acceptance to a single, tight criterion
(e.g. "the typo is fixed in README.md"). Use the minimum useful test command
(typically just \`npm run build\` or \`cargo check\`, not a full test suite). Do NOT
decompose further. Do NOT invent a "verify" story — verification is part of the
single story's acceptance.

If the goal is NON-TRIVIAL: decompose normally per the rules below.

When in doubt, prefer FEWER stories over more. A single 2-file story is better
than two artificially-split 1-file stories.

RUN SHAPE:
baro can run focused, sequential, or parallel work. Parallelism is valuable only
when stories have independent write surfaces. Do NOT create parallel stories
that edit the same file, component, state machine, schema, or API contract.

Mode semantics:
  - focused: exactly one story. Use this for one bug, one UI/component issue,
    one failing build/runtime error, or anything likely centered on a shared
    file/surface. The story should carry enough context to finish the PR.
  - sequential: several small stories with real dependencies. Use this when the
    work is one feature that must be implemented in ordered steps.
  - parallel: a DAG with sibling stories only where you can prove independence
    (different files/modules/contracts). Parallelism requires a reason; do not
    fan out just to use agents.

Dependency rules:
  - Stories touching disjoint files/modules may run in parallel.
  - Stories touching the same file/component/state/API must be sequential or one
    focused story.
  - Only add dependsOn when story B literally cannot start until A is merged
    because B imports a symbol A defines, modifies a file A creates, or relies
    on a schema/API A introduces.
  - Decorative chains are bad, but unsafe parallel edits are worse.

Output ONLY valid JSON matching this exact schema (no markdown, no explanation, just JSON):
{
  "project": "short project name",
  "branchName": "kebab-case-branch-name",
  "description": "one-line description",
  "userStories": [
    {
      "id": "S1",
      "priority": 1,
      "title": "short title",
      "description": "what to implement",
      "dependsOn": [],
      "retries": 2,
      "acceptance": ["testable criterion"],
      "tests": ["npm test"],
      "model": "heavy"
    }
  ]
}

Rules:
- Each story: ONE focused unit of work for one AI agent. Hard cap:
    * touches at most ~10 files
    * fits in a single Claude turn (a few minutes of execution, not an hour)
  Stories that read like "Strip all X" / "Refactor everything that touches Y"
  are TOO BIG. Split them by directory, by feature, or by file group:
    "Delete backend SEF module"
    "Delete frontend SEF wiring"
    "Rename pib→taxId in schema + DTOs"
    "Rename pib→taxId in services + frontend forms"
  Prefer 12-15 small stories over 5 big ones.
- TIER EVERY STORY by blast radius — set "model" on EVERY story to one
  of "light" | "standard" | "heavy". You are the tech lead assigning work
  to a team; pick the tier by asking "if an agent gets THIS story wrong,
  what breaks?" — NOT by raw difficulty:
    * "light"    → nothing important breaks. Mechanical, single-concern,
                   self-contained: a rename, boilerplate, a barrel/index
                   file, one DTO, a config tweak, a doc edit, scaffolding.
    * "standard" → one feature breaks but the damage is contained to its
                   own module: a scoped service method, a component, a
                   focused refactor, tests for non-trivial logic.
    * "heavy"    → other features / the architecture / data integrity
                   break: schema or migration changes, cross-cutting
                   refactors, public API/contract design, integration and
                   wiring stories, anything that several other stories
                   depend on (a hub node in the DAG).
  Tiers are how the operator routes cost: a downstream tier map may send
  "light"/"standard" to a cheaper backend and keep "heavy" on the strongest
  model. Misclassifying UP wastes money; misclassifying DOWN risks a
  broken merge — when genuinely unsure between two tiers, pick the
  HIGHER one. A foundational story that many others depend on is "heavy"
  even if it looks small.
- Use dependsOn for dependencies; same-priority stories with no deps run IN PARALLEL
- Include testable acceptance criteria and test commands
- No circular dependencies
- Start with foundational stories, build up
- IDs: S1, S2, S3...
- Build on existing code, don't recreate what exists
- Output ONLY the JSON, nothing else`

/** Shared by all planner backends so the prompt shape is identical across providers. */
export type ExecutionMode = "focused" | "sequential" | "parallel"

export interface ModeContract {
    mode: ExecutionMode
    confidence: number
    reason: string
    maxStories?: number
    parallelism?: number
    /** Who decided: "user" (explicit pick) | "llm" (intake) | "heuristic". */
    source?: string
}

export function heuristicModeContract(args: {
    goal: string
    quick?: boolean
    decisionDocument?: string
}): ModeContract {
    if (args.quick) {
        return {
            mode: "focused",
            confidence: 1,
            reason: "Quick mode was explicitly requested.",
            maxStories: 1,
            parallelism: 1,
        }
    }
    const goal = args.goal.toLowerCase()
    const bugLike = /\b(fix|bug|error|crash|broken|console|build|doesn'?t|isn'?t|still|again|issue|problem|wrong|shifted|display|render)\b/.test(goal)
    const uiLike = /\b(ui|frontend|react|component|button|card|tab|modal|page|screen|css|style|layout|episode|season)\b/.test(goal)
    const bigLike = /\b(refactor|rewrite|migrate|redesign|implement|add support|multiple|several|backend|frontend|database|api|tests|docs)\b/.test(goal)
    if (bugLike || (uiLike && !bigLike)) {
        return {
            mode: "focused",
            confidence: 0.7,
            reason: "The goal looks like a localized bugfix/follow-up likely centered on shared UI or one code surface.",
            maxStories: 1,
            parallelism: 1,
        }
    }
    if (bigLike) {
        return {
            mode: "sequential",
            confidence: 0.55,
            reason: "The goal may need multiple steps, but no LLM intake proved independent write surfaces.",
            maxStories: 5,
            parallelism: 1,
        }
    }
    return {
        mode: "focused",
        confidence: 0.5,
        reason: "Uncertain goals default to focused mode to avoid unsafe parallel decomposition.",
        maxStories: 1,
        parallelism: 1,
    }
}

export function renderModeContract(decision: ModeContract): string {
    const lines = [
        `mode: ${decision.mode}`,
        `confidence: ${decision.confidence}`,
        `reason: ${decision.reason}`,
    ]
    if (decision.maxStories) lines.push(`maxStories: ${decision.maxStories}`)
    if (decision.parallelism) lines.push(`parallelism: ${decision.parallelism}`)
    if (decision.mode === "focused") {
        lines.push(
            "Planner rules: output EXACTLY ONE story. Do not split. Set model to \"heavy\" so this focused run uses the strong route.",
            "The story must include enough implementation context and acceptance criteria for one agent to finish the PR.",
        )
    } else if (decision.mode === "sequential") {
        lines.push(
            "Planner rules: output a small ordered chain. Use dependsOn for real shared-surface dependencies.",
            "Do not create parallel siblings that edit the same file/component/state/API. Keep each story cheap-model-capable.",
        )
    } else {
        lines.push(
            "Planner rules: output parallel siblings only where write surfaces are independent.",
            "For each sibling story, name its expected write surface in the description. Shared files/components must be sequential.",
        )
    }
    return lines.join("\n")
}

export function buildIntakePrompt(args: {
    goal: string
    quick?: boolean
    projectContext?: string
    decisionDocument?: string
}): string {
    if (args.quick) {
        return JSON.stringify({
            mode: "focused",
            confidence: 1,
            reason: "Quick mode was explicitly requested.",
            maxStories: 1,
            parallelism: 1,
        })
    }
    return [
        "You are Baro Intake. Choose the execution shape BEFORE planning.",
        "",
        "Return ONLY valid JSON with this schema:",
        "{\"mode\":\"focused|sequential|parallel\",\"confidence\":0.0,\"reason\":\"short\",\"maxStories\":1,\"parallelism\":1}",
        "",
        "Definitions:",
        "- focused: one strong agent/story. Use for small bugfixes, UI tweaks, build/runtime errors, one component/file/surface, or unclear shared-write work.",
        "- sequential: multiple small ordered stories. Use when one feature naturally requires steps that touch shared code.",
        "- parallel: only when there are independent write surfaces (different modules/files/contracts) that can safely run at the same time.",
        "",
        "Bias rules:",
        "- If several agents would edit the same file/component/state/schema, choose focused or sequential, not parallel.",
        "- If the prompt is a follow-up bug report from screenshots/console output, choose focused unless it clearly spans independent surfaces.",
        "- If uncertain, choose focused. Unsafe parallelism is worse than leaving speed on the table.",
        "- maxStories is a cap for the planner, not a target.",
        "",
        args.projectContext?.trim()
            ? `Project context summary:\n${args.projectContext.trim().slice(0, 3000)}\n`
            : "",
        args.decisionDocument?.trim()
            ? `Architect decision exists; prefer a compact plan that implements it.\n${args.decisionDocument.trim().slice(0, 3000)}\n`
            : "",
        `User goal:\n${args.goal.trim()}`,
    ].filter(Boolean).join("\n")
}

export function parseModeContract(text: string): ModeContract {
    const json = JSON.parse(extractJsonObject(text)) as Partial<ModeContract>
    const mode = json.mode === "parallel" || json.mode === "sequential" || json.mode === "focused"
        ? json.mode
        : "focused"
    const confidence = Number.isFinite(Number(json.confidence))
        ? Math.max(0, Math.min(1, Number(json.confidence)))
        : 0.5
    return {
        mode,
        confidence,
        reason: typeof json.reason === "string" && json.reason.trim()
            ? json.reason.trim()
            : "No reason supplied by intake.",
        maxStories: Number.isFinite(Number(json.maxStories)) ? Math.max(1, Math.floor(Number(json.maxStories))) : undefined,
        parallelism: Number.isFinite(Number(json.parallelism)) ? Math.max(1, Math.floor(Number(json.parallelism))) : undefined,
        source: typeof json.source === "string" ? json.source : undefined,
    }
}

export function extractJsonObject(text: string): string {
    const trimmed = text.trim()
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    if (fence) return fence[1]!
    const start = trimmed.indexOf("{")
    if (start < 0) throw new Error(`no JSON object in response: ${trimmed.slice(0, 200)}`)
    let depth = 0
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i]
        if (ch === "{") depth++
        else if (ch === "}") {
            depth--
            if (depth === 0) return trimmed.slice(start, i + 1)
        }
    }
    throw new Error(`unbalanced JSON in response: ${trimmed.slice(0, 200)}`)
}

export function buildPlannerUserMessage(args: {
    goal: string
    decisionDocument?: string
    quick?: boolean
    projectContext?: string
    modeContract?: string | ModeContract
}): string {
    const sections: string[] = []

    if (args.projectContext && args.projectContext.trim().length > 0) {
        sections.push("## Project context (CLAUDE.md / equivalent)")
        sections.push("")
        sections.push(args.projectContext.trim())
        sections.push("")
        sections.push("---")
        sections.push("")
    }

    if (args.decisionDocument && args.decisionDocument.trim().length > 0) {
        sections.push(
            "AUTHORITATIVE DESIGN SPEC (already decided by the Architect — every " +
            "story you produce must implement THESE specific file paths, names, and " +
            "shapes; do NOT invent alternatives):",
        )
        sections.push("")
        sections.push(args.decisionDocument.trim())
        sections.push("")
        sections.push("---")
        sections.push("")
    }

    const modeContract = typeof args.modeContract === "string"
        ? args.modeContract
        : args.modeContract
          ? renderModeContract(args.modeContract)
          : undefined
    if (modeContract && modeContract.trim().length > 0) {
        sections.push("EXECUTION MODE CONTRACT (chosen by Baro Intake — obey it):")
        sections.push("")
        sections.push(modeContract.trim())
        sections.push("")
        sections.push("---")
        sections.push("")
    }

    if (args.quick) {
        sections.push(
            "QUICK MODE OVERRIDE — the user invoked `baro --quick`. They have told " +
            "us this goal is trivial. You MUST output EXACTLY ONE story. Do not " +
            "split. Do not decompose. Do not add a `verify` story. If you genuinely " +
            "cannot do this in one story, emit the one story anyway with a " +
            "description that explains what's missing; the user will rerun without " +
            "--quick. One story, tight acceptance, minimum useful test command.",
        )
        sections.push("")
    }

    sections.push("User goal:")
    sections.push(args.goal.trim())
    return sections.join("\n")
}
