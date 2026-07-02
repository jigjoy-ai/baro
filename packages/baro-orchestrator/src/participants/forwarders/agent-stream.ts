import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
} from "@mozaik-ai/core"

import { emit } from "../../tui-protocol.js"

/**
 * Turns the agent bus stream into the TUI's structured Activity feed:
 * ONE condensed `activity` event per bus item.
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

        // Codex maps file_change → tool name "edit".
        if (tool === "write_file" || tool === "edit_file" || tool === "edit") {
            const path = strField(args, "path", "file_path", "file") ?? "(file)"
            const op = tool === "write_file" ? "create" : "modify"
            emit({ type: "activity", id: agentId, kind: "file_change", tool: "write", op, path, text: path })
            return
        }
        // Codex maps command_execution → "shell" with argv in `command`
        // (often ["bash","-lc","<script>"]).
        if (tool === "bash" || tool === "shell") {
            const cmd = firstLine(cmdText(args))
            emit({ type: "activity", id: agentId, kind: "tool_call", tool: "bash", text: truncate(cmd || tool, 140) })
            return
        }
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

/** Extract a shell command from tool args — string or argv array; unwraps `bash -lc "<script>"`. */
function cmdText(args: Record<string, unknown>): string {
    const c = args.command ?? args.cmd ?? args.script
    if (Array.isArray(c)) {
        if (c.length >= 3 && /^(ba)?sh$/.test(String(c[0])) && /^-[lc]+$/.test(String(c[1]))) {
            return String(c[2])
        }
        return c.map(String).join(" ")
    }
    return typeof c === "string" ? c : ""
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
