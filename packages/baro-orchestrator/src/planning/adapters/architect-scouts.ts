/**
 * Repository research the Architect directs, run in parallel.
 *
 * The pre-existing scout is one process taking up to 64 serial model steps
 * before the Architect starts, and it answers a question nobody asked: it
 * produces a generic brief. Here the Architect states what it needs to know
 * and bounded read-only scouts answer, each one a participant of its own.
 *
 * This module owns the asking and the rendering; the answering happens in
 * architect-research-session, where each scout is a participant and each
 * finding is an event. Nothing here fans work out by hand.
 */

import { execFileCli } from "../../harness/exec-file-cli.js"
import { harnessChildEnvironment } from "../../harness/environment.js"
import { llmIdleTimeoutMs } from "../../harness/liveness.js"
import { ClaudeStreamResultCollector } from "../../harness/claude/stream-result.js"
import { extractModelJsonObject } from "../../model-json.js"
import type { GoalEnvelope } from "../../conversation/session/conversation-contract.js"

export const MAX_SCOUT_QUESTIONS = 6
/**
 * A question is cheap text and its scope list is the whole point: at 400 the
 * enumeration question of a live audit was cut mid-path
 * ("…tableSession.service.ts, sr"), silently dropping services from the very
 * list that was meant to be exhaustive.
 */
const MAX_QUESTION_CHARS = 4_000
const MAX_FINDING_CHARS = 4_000
const DEFAULT_SCOUT_TIMEOUT_MS = 4 * 60 * 1000

export interface ScoutQuestion {
    id: string
    question: string
    /** Optional hint at where to look; never a restriction the scout must obey. */
    scope?: string
}

export interface ScoutFinding {
    id: string
    question: string
    answer: string
    ok: boolean
}

const SCOUT_SYSTEM_PROMPT = `You are a Baro repository scout. You answer exactly \
one question about this repository for the Architect who asked it.

Rules:
- Read the code. Never guess, never generalize from a filename.
- Cite file:line for every claim. A claim without a citation is not an answer.
- Report what IS, not what should be. No recommendations, no refactors.
- If the answer is "no such thing exists", say so and name where you looked.
- Be terse: the Architect reads many answers at once. No preamble, no summary
  of the question, no markdown headings.
- You have read-only tools. You never write, and you never run project commands.`

/** The question-generation contract: what does the Architect need to know? */
export const ARCHITECT_RESEARCH_QUESTIONS_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
        questions: {
            type: "array",
            minItems: 0,
            maxItems: MAX_SCOUT_QUESTIONS,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["question"],
                properties: {
                    question: { type: "string", minLength: 8, maxLength: MAX_QUESTION_CHARS },
                    scope: { type: "string", maxLength: 200 },
                },
            },
        },
    },
} as const

export function buildResearchQuestionsPrompt(args: {
    goal: string
    projectContext?: string
    goalEnvelope?: GoalEnvelope
}): string {
    return [
        "You are about to make architecture decisions for the goal below, in a",
        "repository you have not read yet. Before deciding, state what you need",
        `to know. Ask at most ${MAX_SCOUT_QUESTIONS} questions; scouts will answer them`,
        "in parallel and hand you the answers with file:line evidence.",
        "",
        "A good question is one whose answer changes a decision: which module owns",
        "a behavior, whether a convention already exists, what a boundary actually",
        "validates, which callers depend on a shape, where an equivalent was solved",
        "before. Ask nothing you can already answer from the context below, nothing",
        "that is really a design opinion, and nothing that spans the whole codebase",
        "(\"describe the architecture\") — a question a scout cannot answer with",
        "citations is a wasted scout.",
        "",
        "Return ONLY JSON of the form",
        '{"questions":[{"question":"...","scope":"optional path hint"}]}',
        "and an empty array if the context already tells you everything.",
        "",
        ...(args.goalEnvelope
            ? [
                  "Confirmed goal envelope:",
                  `Objective: ${args.goalEnvelope.objective}`,
                  ...args.goalEnvelope.acceptanceCriteria.map((c) => `- acceptance: ${c}`),
                  ...args.goalEnvelope.constraints.map((c) => `- constraint: ${c}`),
                  "",
              ]
            : []),
        ...(args.projectContext?.trim()
            ? [`Repository context:\n${args.projectContext.trim().slice(0, 6_000)}`, ""]
            : []),
        `Goal:\n${args.goal.trim()}`,
    ].join("\n")
}

/** Parse the question list, dropping anything unusable rather than failing. */
export function parseResearchQuestions(text: string): ScoutQuestion[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(extractModelJsonObject(text))
    } catch {
        return []
    }
    const raw = (parsed as { questions?: unknown }).questions
    if (!Array.isArray(raw)) return []
    const questions: ScoutQuestion[] = []
    for (const entry of raw) {
        if (questions.length >= MAX_SCOUT_QUESTIONS) break
        const question = typeof entry === "object" && entry !== null
            ? (entry as { question?: unknown }).question
            : entry
        if (typeof question !== "string" || question.trim().length < 8) continue
        if (question.trim().length > MAX_QUESTION_CHARS) {
            // Loudly refused, never quietly trimmed: a half a scope list reads
            // as a complete one to the scout that receives it.
            process.stderr.write(
                `[architect-scouts] dropped a question of ${question.trim().length} chars; ` +
                    `the limit is ${MAX_QUESTION_CHARS}\n`,
            )
            continue
        }
        const scope = typeof entry === "object" && entry !== null
            ? (entry as { scope?: unknown }).scope
            : undefined
        questions.push({
            id: `Q${questions.length + 1}`,
            question: question.trim(),
            ...(typeof scope === "string" && scope.trim()
                ? { scope: scope.trim().slice(0, 200) }
                : {}),
        })
    }
    return questions
}

const QUESTION_ROUND_SYSTEM_PROMPT = `You are the Baro Architect, in its \
research phase. You do not decide anything yet: you state what you must learn \
about this repository before you can decide well. Return ONLY the JSON object \
the schema describes.`

export interface ResearchQuestionRoundOptions {
    goal: string
    cwd: string
    model?: string
    effort?: string
    claudeBin?: string
    projectContext?: string
    goalEnvelope?: GoalEnvelope
    timeoutMs?: number
    /** Test seam; production shells out to the Claude CLI. */
    generate?: (prompt: string) => Promise<string>
}

/** Pass one: the Architect asks. Never throws — no questions is a valid answer. */
export async function runResearchQuestionRound(
    opts: ResearchQuestionRoundOptions,
): Promise<ScoutQuestion[]> {
    const prompt = buildResearchQuestionsPrompt({
        goal: opts.goal,
        projectContext: opts.projectContext,
        goalEnvelope: opts.goalEnvelope,
    })
    if (opts.generate) return parseResearchQuestions(await opts.generate(prompt))
    const collector = new ClaudeStreamResultCollector()
    await execFileCli(
        opts.claudeBin ?? "claude",
        [
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            ...(opts.model ? ["--model", opts.model] : []),
            ...(opts.effort ? ["--effort", opts.effort] : []),
            "--json-schema",
            JSON.stringify(ARCHITECT_RESEARCH_QUESTIONS_JSON_SCHEMA),
            "--tools",
            "Read,Glob,Grep",
            "--safe-mode",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--no-session-persistence",
            "--permission-mode",
            "dontAsk",
            "--system-prompt",
            QUESTION_ROUND_SYSTEM_PROMPT,
            "-p",
            prompt,
        ],
        {
            cwd: opts.cwd,
            env: harnessChildEnvironment(),
            timeout: opts.timeoutMs ?? 3 * 60 * 1000,
            idleTimeoutMs: llmIdleTimeoutMs(),
            maxBuffer: 8 * 1024 * 1024,
            onStdoutData: (chunk) => collector.feed(chunk),
        },
    )
    const line = collector.resultLine()
    if (!line) return []
    const wrapper = JSON.parse(line) as {
        result?: unknown
        structured_output?: unknown
    }
    if (wrapper.structured_output !== undefined) {
        return parseResearchQuestions(JSON.stringify(wrapper.structured_output))
    }
    return typeof wrapper.result === "string"
        ? parseResearchQuestions(wrapper.result)
        : []
}

/** Findings as the Architect sees them: its own questions, answered. */
export function renderScoutFindings(findings: readonly ScoutFinding[]): string {
    if (findings.length === 0) return ""
    return [
        "## Repository research (answers to your own questions)",
        "Each answer comes from a scout that read this repository. Citations are",
        "the scout's; treat an unanswered question as unknown, never as absent.",
        "",
        ...findings.map(({ id, question, answer, ok }) =>
            `### ${id}${ok ? "" : " (unanswered)"} ${question}\n${answer}\n`,
        ),
    ].join("\n")
}
