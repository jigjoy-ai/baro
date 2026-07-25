/**
 * Auditor — passive observer that persists every bus event to a JSONL
 * file for replay and post-mortem debugging.
 */

import { createHmac, randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "fs"
import { dirname } from "path"

import {
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    ReasoningItem,
    SemanticEvent,
} from "../runtime/mozaik.js"

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
    /** Per-log one-way correlation key. Raw lease bearers must never become a
     * credential oracle for unsandboxed sibling workers. */
    private readonly leaseFingerprintKey = randomBytes(32)
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
            if (existsSync(this.path)) chmodSync(this.path, 0o600)
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
            appendFileSync(this.path, this.serialize(entry) + "\n", {
                encoding: "utf8",
                mode: 0o600,
            })
        } catch (e) {
            this.disable(`append failed: ${(e as Error)?.message ?? String(e)}`)
        }
    }

    private serialize(entry: Record<string, unknown>): string {
        return JSON.stringify(entry, (key, value: unknown) => {
            if (key === "leaseId" && typeof value === "string") {
                return this.leaseFingerprint(value)
            }
            return typeof value === "string"
                ? redactEmbeddedLeaseBearers(
                      value,
                      (leaseId) => this.leaseFingerprint(leaseId),
                  )
                : value
        })
    }

    private leaseFingerprint(leaseId: string): string {
        return `audit-lease:${createHmac("sha256", this.leaseFingerprintKey)
            .update(leaseId)
            .digest("hex")
            .slice(0, 24)}`
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

function redactEmbeddedLeaseBearers(
    value: string,
    fingerprint: (leaseId: string) => string,
): string {
    return value
        .replace(
            /(--lease\s+)"([^"\r\n]+)"/g,
            (_match, prefix: string, leaseId: string) =>
                `${prefix}"${fingerprint(leaseId)}"`,
        )
        .replace(
            /(--lease\s+)\\"([^"\\\r\n]+)\\"/g,
            (_match, prefix: string, leaseId: string) =>
                `${prefix}\\"${fingerprint(leaseId)}\\"`,
        )
        .replace(
            /("leaseId"\s*:\s*")([^"]+)(")/g,
            (_match, prefix: string, leaseId: string, suffix: string) =>
                `${prefix}${fingerprint(leaseId)}${suffix}`,
        )
        .replace(
            /(\\"leaseId\\"\s*:\s*\\")([^"\\]+)(\\")/g,
            (_match, prefix: string, leaseId: string, suffix: string) =>
                `${prefix}${fingerprint(leaseId)}${suffix}`,
        )
}
