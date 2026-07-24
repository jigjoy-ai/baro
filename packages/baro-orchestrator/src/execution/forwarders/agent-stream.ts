import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    SemanticEvent,
} from "../../runtime/mozaik.js"

import {
    WorkLeaseGranted,
    WorkLeaseReleased,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"
import { ActiveLeaseRegistry } from "../../runtime/active-lease-registry.js"
import type { StoryOutcomeAuthority } from "../../runtime/story-outcome-authority.js"
import { testVerdict } from "./test-verdict.js"

/**
 * Turns the agent bus stream into the TUI's structured Activity feed:
 * ONE condensed `activity` event per bus item.
 */
export class AgentStreamForwarder extends BaseObserver {
    private readonly leases = new ActiveLeaseRegistry()
    private collectiveAuthorities: Readonly<CollectiveAgentStreamAuthorities> | null = null

    constructor(private readonly collectiveFailClosed = false) {
        super()
    }

    sealCollectiveAuthorities(
        authorities: CollectiveAgentStreamAuthorities,
    ): void {
        if (this.collectiveAuthorities) {
            throw new Error(
                "agent stream forwarder collective authorities are already sealed",
            )
        }
        this.collectiveAuthorities = Object.freeze({ ...authorities })
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (!WorkLeaseGranted.is(event) && !WorkLeaseReleased.is(event)) return
        const authorities = this.collectiveAuthorities
        if (
            !authorities ||
            source !== authorities.broker ||
            event.data.runId !== authorities.runId
        ) return
        if (
            WorkLeaseReleased.is(event) &&
            !this.leases.matchesLease(
                event.data.storyId,
                event.data.runId,
                event.data.leaseId,
            )
        ) return
        this.leases.observe(event, authorities.runId)
    }

    override async onExternalModelMessage(source: Participant, item: ModelMessageItem): Promise<void> {
        const agentId = this.authorizedAgentId(source)
        if (!agentId) return
        const json = item.toJSON() as { content?: Array<{ text?: string }> }
        const text = json.content?.[0]?.text ?? ""
        const line = firstLine(text)
        if (!line) return
        emit({ type: "activity", id: agentId, kind: "agent_msg", text: truncate(line, 160) })
    }

    override async onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> {
        const agentId = this.authorizedAgentId(source)
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
        const agentId = this.authorizedAgentId(source)
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

    private authorizedAgentId(source: Participant): string | null {
        const agentId = agentIdOf(source)
        if (!agentId) return null
        const isCollective =
            this.collectiveFailClosed || this.collectiveAuthorities !== null
        if (!isCollective) return agentId
        const authorities = this.collectiveAuthorities
        if (!authorities) return null
        const correlation =
            authorities.outcomeAuthority.terminalCorrelationForSource(
                source,
                agentId,
            )
        if (!correlation) return null
        return this.leases.matches(
            {
                storyId: correlation.storyId,
                success: false,
                attempts: 0,
                durationSecs: 0,
                error: null,
                runId: correlation.runId,
                leaseId: correlation.leaseId,
                generation: correlation.generation,
            },
            authorities.runId,
        )
            ? agentId
            : null
    }
}

export interface CollectiveAgentStreamAuthorities {
    runId: string
    broker: Participant
    outcomeAuthority: StoryOutcomeAuthority
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
