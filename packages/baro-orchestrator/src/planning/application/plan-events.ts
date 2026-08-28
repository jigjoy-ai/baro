/**
 * Planner/Architect exploration → the live BaroEvent feed. Emitted on stdout
 * under story id "plan" (the id the dashboard renders planning under), so the
 * "architecting the solution…" wait shows real progress. Gated on
 * BARO_PLAN_EVENTS: the run-planner/run-architect scripts set it only once
 * they've moved the RESULT off stdout (to --result-file), so a bare script
 * invocation never corrupts its stdout with event JSON.
 */

import { emit } from "../../tui-protocol.js"

function enabled(): boolean {
    return process.env.BARO_PLAN_EVENTS === "1"
}

/** One concise human line to the planning feed. */
export function emitPlanLine(line: string): void {
    const trimmed = line.replace(/\s+/g, " ").trim()
    if (!enabled() || !trimmed) return
    emit({ type: "story_log", id: "plan", line: trimmed })
}

/**
 * A planning-lane activity line the operator always sees. Deliberately outside
 * the BARO_PLAN_EVENTS gate: this is the only channel that makes a planning
 * decision visible in the feed, so gating it would hide the very warning it
 * exists to raise. Whitespace is collapsed because `emit` forbids newlines.
 */
export function emitPlanActivity(kind: "warn" | "error", text: string): void {
    const trimmed = text.replace(/\s+/g, " ").trim()
    if (!trimmed) return
    emit({ type: "activity", id: "plan", kind, text: trimmed })
}

/** Describe one tool call the planner/architect made while exploring. */
export function emitToolCall(name: string, argsJson: string | undefined): void {
    if (!enabled()) return
    emitPlanLine(describeToolCall(name, argsJson))
}

function describeToolCall(name: string, argsJson: string | undefined): string {
    let a: Record<string, unknown> = {}
    try {
        a = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    } catch {
        /* unparseable args — fall back to the bare tool name */
    }
    const s = (v: unknown): string => (typeof v === "string" ? v : "")
    switch (name) {
        case "read_file":
            return `reading ${s(a.path) || "?"}`
        case "list_files":
            return `listing ${s(a.path) || "root"}`
        case "file_tree":
            return "scanning project tree"
        case "grep":
            return `searching "${clip(s(a.pattern), 60)}"`
        case "glob":
            return `globbing ${s(a.pattern) || "?"}`
        case "bash":
            return `$ ${clip(s(a.command), 80)}`
        default:
            return name
    }
}

function clip(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim()
    return one.length > n ? one.slice(0, n) + "…" : one
}
