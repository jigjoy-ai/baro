/**
 * PlannerSession — the conversational planner behind interactive,
 * chat-driven planning (see docs/desktop-ui-and-interactive-planning.md,
 * issue #37).
 *
 * The one-shot planner (`run-planner.ts`) emits a `prd.json` and exits.
 * This session instead holds a **draft PRD + chat transcript** and lets a
 * human reshape the DAG across turns before anything runs:
 *
 *   seed(goal) ─► draft  ─┐
 *                         ├─ handleMessage("split the service story") ─► draft'
 *                         ├─ handleMessage("cheap ones on minimax")   ─► draft''
 *                         └─ … until the user commits (RUN, handled by the caller)
 *
 * Elegance via reuse: each turn the model returns a **mutation** in the
 * exact vocabulary the Surgeon already speaks (add / remove / rewire),
 * plus a `retier` map — and we apply it with the Surgeon's own pure
 * `applyReplan` (+ a tier pass). The interactive planner is "the Surgeon,
 * driven by the user, before the run."
 *
 * The model call is **injectable** (`PlannerModelCall`) so this is unit
 * testable with a scripted model and runs for real via `claude --print`.
 */

import { spawn } from "child_process"

import { buildDag } from "../dag.js"
import { applyReplan } from "../participants/conductor.js"
import { extractJsonObject } from "../participants/surgeon.js"
import {
    normalizePrd,
    type PrdFile,
    type PrdStory,
} from "../prd.js"
import type { ReplanData, ReplanStoryAdd } from "../semantic-events.js"

/**
 * Calls a chat/instruct model with a system + user prompt and returns its
 * raw text. Injectable so tests can script it; the default shells out to
 * `claude --print` exactly like the Surgeon.
 */
export type PlannerModelCall = (
    systemPrompt: string,
    userPrompt: string,
) => Promise<string>

export interface PlannerSessionOptions {
    goal: string
    /** Claude model for the default model call. Default: "opus". */
    model?: string
    /** Override the model call (tests, alternate backends). */
    call?: PlannerModelCall
    /** Path to the `claude` binary for the default call. Default: "claude". */
    claudeBin?: string
    /** Per-call timeout (ms) for the default call. Default: 120_000. */
    timeoutMs?: number
}

export interface PlannerTurn {
    /** Human-facing message from the planner. */
    reply: string
    /** The draft after this turn (also available as `session.draft`). */
    draft: PrdFile
    /**
     * Set when the model's mutation was rejected (e.g. it introduced a
     * dependency cycle). The draft is left unchanged and `reply` explains.
     */
    rejected?: string
}

/** The per-turn shape the planner model must return. */
interface PlannerMutation {
    reply: string
    addedStories?: ReplanStoryAdd[]
    removedStoryIds?: string[]
    modifiedDeps?: { id: string; newDependsOn: string[] }[]
    /** storyId → tier ("haiku" | "sonnet" | "opus" | backend:model). */
    retier?: Record<string, string>
}

const SEED_SYSTEM = `You are baro's interactive planner. Produce an INITIAL plan for the user's goal as a dependency DAG of small stories, then you will refine it conversationally.

Tier every story by blast radius via "model": "haiku" (mechanical/self-contained), "sonnet" (one contained module), or "opus" (cross-cutting / schema / wiring / a DAG hub). When unsure, pick higher.

Keep stories small (≤~10 files, one focused unit). Prefer parallel siblings over linear chains — only add dependsOn when B literally needs a symbol/file/schema A introduces.

Output ONLY valid JSON (no markdown) matching:
{"project":"…","branchName":"kebab-case","description":"…","userStories":[
 {"id":"S1","priority":1,"title":"…","description":"…","dependsOn":[],"retries":2,"acceptance":["…"],"tests":["npm test"],"model":"opus"}]}`

const TURN_SYSTEM = `You are baro's interactive planner, refining an existing draft DAG with the user. You are given the CURRENT DRAFT (JSON) and the user's message. Respond with a single JSON object describing how to mutate the draft — same vocabulary as baro's Surgeon, plus retier:

{"reply":"one short human-facing sentence",
 "addedStories":[{"id":"S?","priority":N,"title":"…","description":"…","dependsOn":["…"],"acceptance":["…"],"tests":["npm test"],"model":"sonnet"}],
 "removedStoryIds":["S?"],
 "modifiedDeps":[{"id":"S?","newDependsOn":["…"]}],
 "retier":{"S2":"haiku"}}

Rules:
- Added ids must not collide with existing ids. Never remove a story that already passed.
- To SPLIT a story: remove it and add 2-3 smaller stories that cover its acceptance; rewire any dependents via modifiedDeps.
- "retier" only changes the "model" tier of existing stories (haiku|sonnet|opus); use it for "make X cheaper/stronger" or "cheap ones on <backend>".
- Keep the DAG acyclic. If the user only asks a question, return just {"reply":"…"} with no mutations.
- Output ONLY the JSON object, nothing else.`

export class PlannerSession {
    public draft: PrdFile | null = null
    private readonly transcript: { role: "user" | "planner"; text: string }[] = []
    private readonly opts: Required<
        Pick<PlannerSessionOptions, "model" | "claudeBin" | "timeoutMs">
    > &
        PlannerSessionOptions
    private readonly call: PlannerModelCall

    constructor(opts: PlannerSessionOptions) {
        this.opts = {
            model: opts.model ?? "opus",
            claudeBin: opts.claudeBin ?? "claude",
            timeoutMs: opts.timeoutMs ?? 120_000,
            ...opts,
        }
        this.call = opts.call ?? this.defaultCall.bind(this)
    }

    /** Produce the initial draft from the goal. Idempotent-ish: re-seeding replaces the draft. */
    async seed(): Promise<PrdFile> {
        const raw = await this.call(SEED_SYSTEM, `User goal:\n${this.opts.goal}`)
        const parsed = JSON.parse(extractJsonObject(raw)) as Partial<PrdFile>
        this.draft = normalizePrd(parsed, "planner-session")
        // Validate the DAG up front so a broken seed fails loudly.
        buildDag(this.draft.userStories)
        this.transcript.push({ role: "user", text: this.opts.goal })
        return this.draft
    }

    /** One conversational refinement turn. Returns the reply + new draft. */
    async handleMessage(text: string): Promise<PlannerTurn> {
        if (!this.draft) throw new Error("PlannerSession: call seed() before handleMessage()")
        this.transcript.push({ role: "user", text })

        const userPrompt = [
            "CURRENT DRAFT:",
            JSON.stringify(toDraftView(this.draft), null, 2),
            "",
            "USER MESSAGE:",
            text,
        ].join("\n")

        const raw = await this.call(TURN_SYSTEM, userPrompt)
        const mutation = JSON.parse(extractJsonObject(raw)) as PlannerMutation
        const reply = typeof mutation.reply === "string" ? mutation.reply : "(no reply)"

        const next = applyMutation(this.draft, mutation)

        // Reject a mutation that breaks the DAG; keep the prior draft.
        try {
            buildDag(next.userStories)
        } catch (e) {
            const why = (e as Error).message
            this.transcript.push({
                role: "planner",
                text: `${reply} (rejected: ${why})`,
            })
            return { reply, draft: this.draft, rejected: why }
        }

        this.draft = next
        this.transcript.push({ role: "planner", text: reply })
        return { reply, draft: next }
    }

    private defaultCall(
        systemPrompt: string,
        userPrompt: string,
    ): Promise<string> {
        // `claude --print` reads the prompt from stdin — robust to large
        // drafts (no argv length limit), same binary the Surgeon uses.
        return new Promise<string>((res, rej) => {
            const child = spawn(
                this.opts.claudeBin,
                ["--print", "--model", this.opts.model],
                { stdio: ["pipe", "pipe", "inherit"] },
            )
            let out = ""
            const timer = setTimeout(() => {
                child.kill("SIGKILL")
                rej(new Error(`planner model call timed out after ${this.opts.timeoutMs}ms`))
            }, this.opts.timeoutMs)
            child.stdout.on("data", (d: Buffer) => (out += d.toString()))
            child.on("error", (e) => { clearTimeout(timer); rej(e) })
            child.on("close", (code) => {
                clearTimeout(timer)
                if (code === 0) res(out)
                else rej(new Error(`planner model call exited ${code}`))
            })
            child.stdin.write(`${systemPrompt}\n\n${userPrompt}`)
            child.stdin.end()
        })
    }
}

/** A compact, model-facing view of the draft (drops result bookkeeping). */
function toDraftView(prd: PrdFile) {
    return {
        project: prd.project,
        description: prd.description,
        userStories: prd.userStories.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description,
            dependsOn: s.dependsOn,
            model: s.model ?? "opus",
        })),
    }
}

/**
 * Apply a planner mutation to a draft: structural changes via the
 * Surgeon's pure `applyReplan`, then a tier pass for `retier`.
 */
export function applyMutation(prd: PrdFile, mutation: PlannerMutation): PrdFile {
    const replan: ReplanData = {
        source: "planner",
        reason: mutation.reply ?? "",
        addedStories: mutation.addedStories ?? [],
        removedStoryIds: mutation.removedStoryIds ?? [],
        modifiedDeps: Object.fromEntries(
            (mutation.modifiedDeps ?? []).map((m) => [m.id, m.newDependsOn]),
        ),
    }
    let next = applyReplan(prd, replan)

    if (mutation.retier && Object.keys(mutation.retier).length > 0) {
        const retier = mutation.retier
        next = {
            ...next,
            userStories: next.userStories.map((s): PrdStory =>
                retier[s.id] ? { ...s, model: retier[s.id] } : s,
            ),
        }
    }
    return next
}
