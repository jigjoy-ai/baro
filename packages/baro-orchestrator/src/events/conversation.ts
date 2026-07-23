/** User conversation lane: dialogue, front-door intake, repository context. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { defineSemanticEvent } from "./define.js"
import type { ConversationResponse } from "../session/conversation-contract.js"
import type { ConversationRequestIntent } from "../session/conversation-intake.js"
import type { RepositoryBriefV1 } from "../session/repository-brief.js"

// Optional conversation participant. It may observe and communicate, but
// these events deliberately carry no lease, integration, verification, or
// completion authority.

export interface ConversationRequestedData {
    runId: string
    messageId: string
    text: string
    source: "user" | "operator"
}

export const ConversationRequested =
    defineSemanticEvent<ConversationRequestedData>("conversation_requested")

export interface ConversationAction {
    kind: "message"
    recipientId: string
    text: string
}

/** Narrow implementation scope a conversational participant may propose.
 * Scheduling priority, retry policy and model/route selection are deliberately
 * absent: those remain Board and worker-market decisions. */
export interface ConversationDelegatedStory {
    id: string
    title: string
    description: string
    dependsOn: readonly string[]
    acceptance: readonly string[]
    tests: readonly string[]
    goalInvariantIds?: readonly string[]
}

/** Advisory, add-only work proposal from the exact bound DialogueAgent.
 * The Board remains the sole graph authority and must validate this against
 * the correlated graph version before it can become runnable work. */
export interface ConversationDelegationProposedData {
    runId: string
    messageId: string
    proposalId: string
    agentId: string
    baseGraphVersion: number
    reason: string
    addedStories: readonly ConversationDelegatedStory[]
}

export const ConversationDelegationProposed =
    defineSemanticEvent<ConversationDelegationProposedData>(
        "conversation_delegation_proposed",
    )

export interface ConversationRespondedData {
    runId: string
    messageId: string
    agentId: string
    text: string
    actions: readonly ConversationAction[]
}

export const ConversationResponded =
    defineSemanticEvent<ConversationRespondedData>("conversation_responded")

export interface ConversationFailedData {
    runId: string
    messageId: string
    agentId: string
    error: string
}

export const ConversationFailed =
    defineSemanticEvent<ConversationFailedData>("conversation_failed")

// Short-lived, pre-PRD conversation lane. These events intentionally carry no
// cwd, model, route, worker, DAG, lease, or execution authority. Exact source
// participant identity is enforced by the front-door participants.

export interface FrontDoorConversationRequestedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    intent: ConversationRequestIntent
    text: string
}

export const FrontDoorConversationRequested =
    defineSemanticEvent<FrontDoorConversationRequestedData>(
        "frontdoor_conversation_requested",
    )

export interface RepositoryContextRequestedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    contextRequestId: string
    intent: Exclude<ConversationRequestIntent, "chat">
    query: string
}

export const RepositoryContextRequested =
    defineSemanticEvent<RepositoryContextRequestedData>(
        "repository_context_requested",
    )

export interface RepositoryContextProvidedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    contextRequestId: string
    scoutId: string
    brief: RepositoryBriefV1
}

export const RepositoryContextProvided =
    defineSemanticEvent<RepositoryContextProvidedData>(
        "repository_context_provided",
    )

export type RepositoryContextFailureCode =
    | "timeout"
    | "scan_failed"
    | "invalid_brief"
    | "request_conflict"

export interface RepositoryContextFailedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    contextRequestId: string
    scoutId: string
    code: RepositoryContextFailureCode
    error: string
}

export const RepositoryContextFailed =
    defineSemanticEvent<RepositoryContextFailedData>(
        "repository_context_failed",
    )

export interface FrontDoorConversationCompletedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    response: ConversationResponse
}

export const FrontDoorConversationCompleted =
    defineSemanticEvent<FrontDoorConversationCompletedData>(
        "frontdoor_conversation_completed",
    )

export interface FrontDoorConversationFailedData {
    schemaVersion: 1
    sessionId: string
    requestId: string
    error: string
}

export const FrontDoorConversationFailed =
    defineSemanticEvent<FrontDoorConversationFailedData>(
        "frontdoor_conversation_failed",
    )
