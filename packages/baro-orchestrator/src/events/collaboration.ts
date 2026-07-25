/** Cross-agent collaboration: knowledge sharing, targeted messages, peer help. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"

// Bus routing

export interface KnowledgeData {
    /** Source agent that produced the underlying tool call. */
    sourceAgentId: string
    /** Free-form tags for relevance matching (e.g. file path, pattern). */
    tags: readonly string[]
    /** Short headline (e.g. "package.json read", "grep 'authToken'"). */
    summary: string
    /** Full content (file body, command output, etc). */
    content: string
    /** Tool that produced it ("Read" | "Grep" | "Bash" | "Glob" …). */
    tool: string
}

export const Knowledge = defineSemanticEvent<KnowledgeData>("knowledge")

export interface CoordinationData {
    fromAgentId: string
    recipientId: string
    kind: "wait" | "merge" | "abort" | "notice"
    reason: string
    payload: Readonly<Record<string, unknown>>
}

export const Coordination = defineSemanticEvent<CoordinationData>("coordination")

export interface AgentTargetedMessageData {
    recipientId: string
    text: string
    metadata: Readonly<Record<string, unknown>>
    /** Present together only on a CollaborationBridge-authenticated
     * collective delivery. Uncorrelated events remain legacy-compatible
     * message intents and carry no execution authority. */
    runId?: string
    leaseId?: string
    generation?: number
}

export const AgentTargetedMessage =
    defineSemanticEvent<AgentTargetedMessageData>("agent_targeted_message")

export interface PeerHelpRequestedData {
    runId: string
    sourceAgentId: string
    text: string
}

export const PeerHelpRequested =
    defineSemanticEvent<PeerHelpRequestedData>("peer_help_requested")

export interface CollaborationNoteData {
    runId: string
    sourceAgentId: string
    text: string
}

export const CollaborationNote =
    defineSemanticEvent<CollaborationNoteData>("collaboration_note")
