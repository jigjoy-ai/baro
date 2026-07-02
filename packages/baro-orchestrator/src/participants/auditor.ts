/**
 * Auditor — passive observer that persists every bus event to a JSONL
 * file for replay and post-mortem debugging.
 */

import { appendFileSync, mkdirSync } from "fs"
import { dirname } from "path"

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    ReasoningItem,
    SemanticEvent,
} from "@mozaik-ai/core"

import { ClaudeStreamChunk } from "../semantic-events.js"

// Auditor never calls `.toJSON()` itself — `JSON.stringify` invokes it
// per-item where it exists and falls back to enumerable properties for
// `SemanticEvent`.
type AuditableItem =
    | SemanticEvent<unknown>
    | ModelMessageItem
    | FunctionCallItem
    | FunctionCallOutputItem
    | ReasoningItem

export interface AuditorOptions {
    /** Path to the JSONL log file. Parent directories are created if needed. */
    path: string
    /**
     * Skip `claude_stream_chunk` events. Default: true — partial-message
     * chunks dominate volume and rarely add audit value.
     */
    skipStreamChunks?: boolean
    /** Event is written iff this returns true. Runs after `skipStreamChunks`. */
    filter?: (source: Participant, event: AuditableItem) => boolean
}

export class Auditor extends BaseObserver {
    private readonly path: string
    private readonly skipStreamChunks: boolean
    private readonly filter?: (source: Participant, event: AuditableItem) => boolean
    /**
     * Set on the first write failure (e.g. EACCES from a sudo-installed
     * `~/.baro/runs/`); later events drop silently — losing the audit log
     * is better than crashing the orchestrator on every bus event.
     */
    private disabled = false

    constructor(opts: AuditorOptions) {
        super()
        this.path = opts.path
        this.skipStreamChunks = opts.skipStreamChunks ?? true
        this.filter = opts.filter
        try {
            mkdirSync(dirname(this.path), { recursive: true })
        } catch (e) {
            this.disable(`mkdir failed: ${(e as Error)?.message ?? String(e)}`)
        }
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        this.write(source, event)
    }

    override async onExternalModelMessage(source: Participant, item: ModelMessageItem): Promise<void> {
        this.write(source, item)
    }

    override async onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> {
        this.write(source, item)
    }

    override async onExternalFunctionCallOutput(
        source: Participant,
        item: FunctionCallOutputItem,
    ): Promise<void> {
        this.write(source, item)
    }

    override async onExternalReasoning(source: Participant, item: ReasoningItem): Promise<void> {
        this.write(source, item)
    }

    private write(source: Participant, item: AuditableItem): void {
        if (this.disabled) return
        if (
            this.skipStreamChunks &&
            item instanceof SemanticEvent &&
            ClaudeStreamChunk.is(item)
        ) {
            return
        }
        if (this.filter && !this.filter(source, item)) return
        const entry = {
            ts: new Date().toISOString(),
            source: this.sourceLabel(source),
            item,
        }
        try {
            appendFileSync(this.path, JSON.stringify(entry) + "\n")
        } catch (e) {
            this.disable(`append failed: ${(e as Error)?.message ?? String(e)}`)
        }
    }

    private disable(reason: string): void {
        if (this.disabled) return
        this.disabled = true
        process.stderr.write(
            `[auditor] cannot write audit log at ${this.path}: ${reason} — continuing without audit\n`,
        )
    }

    private sourceLabel(source: Participant): string {
        const ctor = source.constructor.name
        const idCandidate = (source as unknown as { agentId?: string }).agentId
        return typeof idCandidate === "string" ? `${ctor}:${idCandidate}` : ctor
    }
}
