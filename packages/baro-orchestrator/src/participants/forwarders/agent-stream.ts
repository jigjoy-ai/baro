import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
} from "@mozaik-ai/core"

import { emit } from "../../tui-protocol.js"

/**
 * Turns the agent bus stream into the structured Activity feed for the TUI.
 *
 * Subscribes to: ModelMessageItem, FunctionCallItem, FunctionCallOutputItem
 * Emits: BaroEvent { type: "activity" } — ONE condensed, typed line per bus
 * item (not the old line-by-line `story_log` firehose, which split full tool
 * args / file reads / model output into hundreds of raw lines and both pegged
 * the TUI render and was unreadable).
 */
export class AgentStreamForwarder extends BaseObserver {
    override async onExternalModelMessage(source: Participant, item: ModelMessageItem): Promise<void> {
        const agentId = agentIdOf(source)
        if (!agentId) return
        const json = item.toJSON() as { content?: Array<{ text?: string }> }
        const text = json.content?.[0]?.text ?? ""
        const line = firstLine(text)
        if (!line) return
        emit({ type: "activity", id: agentId, kind: "agent_msg", text: truncate(line, 160) })
    }

    override async onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> {
        const agentId = agentIdOf(source)
        if (!agentId) return
        const args = parseArgs(item.args)
        const tool = item.name

        // File writes/edits surface as file_change (path + op).
        if (tool === "write_file" || tool === "edit_file") {
            const path = strField(args, "path", "file_path", "file") ?? "(file)"
            const op = tool === "edit_file" ? "modify" : "create"
            emit({ type: "activity", id: agentId, kind: "file_change", tool: "write", op, path, text: path })
            return
        }
        if (tool === "bash") {
            const cmd = firstLine(strField(args, "command", "cmd", "script") ?? "")
            emit({ type: "activity", id: agentId, kind: "tool_call", tool: "bash", text: truncate(cmd || "bash", 140) })
            return
        }
        // Read-ish tools: read_file, list_files, file_tree, grep, glob.
        const target = strField(args, "path", "file_path", "pattern", "query", "file") ?? ""
        const text = target ? `${tool} ${target}` : tool
        emit({ type: "activity", id: agentId, kind: "tool_call", tool: "read", text: truncate(text, 140) })
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        const agentId = agentIdOf(source)
        if (!agentId) return
        const json = item.toJSON() as { output?: Array<{ text?: string }> }
        const out = json.output?.[0]?.text ?? ""
        if (!out.trim()) return

        // Detect a test run result and surface it as a typed `test` entry.
        const verdict = testVerdict(out)
        if (verdict !== null) {
            emit({
                type: "activity",
                id: agentId,
                kind: "test",
                ok: verdict,
                text: truncate(firstLine(out) || (verdict ? "tests passed" : "tests failed"), 140),
            })
            return
        }
        // Everything else: a single condensed result line (not the full output).
        emit({ type: "activity", id: agentId, kind: "tool_result", text: truncate(firstLine(out), 120) })
    }
}

function agentIdOf(source: Participant): string | null {
    const id = (source as unknown as { agentId?: string }).agentId
    return typeof id === "string" ? id : null
}

function parseArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object") return raw as Record<string, unknown>
    if (typeof raw === "string") {
        try {
            const v = JSON.parse(raw)
            return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
        } catch {
            return {}
        }
    }
    return {}
}

function strField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const k of keys) {
        const v = obj[k]
        if (typeof v === "string" && v.length > 0) return v
    }
    return undefined
}

function firstLine(s: string): string {
    for (const l of s.split("\n")) {
        const t = l.trim()
        if (t) return t
    }
    return ""
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

/** true = passed, false = failed, null = not a recognizable test result. */
function testVerdict(out: string): boolean | null {
    const s = out.toLowerCase()
    const failed = /\b\d+\s+fail(ed|ing|ures?)?\b/.test(s) || /(^|\s)fail\b/.test(s)
    const passed =
        /\b(all\s+)?\d+\s+(tests?\s+)?(pass(ed|ing)?|ok)\b/.test(s) || /\btests?\s+pass(ed)?\b/.test(s)
    if (failed) return false
    if (passed) return true
    return null
}
