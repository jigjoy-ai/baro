import { createHash } from "node:crypto"

import {
    type ConversationDelegatedStory,
    type ConversationDelegationProposedData,
    type RuntimeReplanProposedData,
} from "../semantic-events.js"

export const MAX_CONVERSATION_DELEGATED_STORIES = 2
export const DEFAULT_CONVERSATION_STORY_PRIORITY = 1_000_000

const MAX_ID_LENGTH = 128
const MAX_REASON_LENGTH = 2_000
const MAX_TITLE_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 8_000
const MAX_LIST_ITEMS = 16
const MAX_LIST_ITEM_LENGTH = 1_000
const MAX_I32 = 2_147_483_647

export interface ParsedConversationDelegation {
    reason: string
    addedStories: ConversationDelegatedStory[]
}

export type ConversationDelegationProposalValidation =
    | { ok: true; proposal: ConversationDelegationProposedData }
    | { ok: false; reason: string }

/** Stable, bounded identity for replaying the same operator turn. */
export function conversationDelegationProposalId(
    runId: string,
    messageId: string,
): string {
    const digest = createHash("sha256")
        .update(runId)
        .update("\0")
        .update(messageId)
        .digest("hex")
    return `conversation:${digest}`
}

/**
 * Parse the model-facing `delegation` object into an add-only domain value.
 * Unknown keys fail the whole atomic proposal instead of silently broadening
 * conversational authority or applying only part of the requested scope.
 */
export function parseConversationDelegation(
    value: unknown,
): ParsedConversationDelegation | null {
    if (value === undefined || value === null) return null
    if (!isExactRecord(value, ["reason", "stories"])) return null

    const reason = normalizedString(value.reason, MAX_REASON_LENGTH)
    if (!reason || !Array.isArray(value.stories)) return null
    if (
        value.stories.length === 0 ||
        value.stories.length > MAX_CONVERSATION_DELEGATED_STORIES
    ) return null

    const addedStories: ConversationDelegatedStory[] = []
    const storyIds = new Set<string>()
    for (const candidate of value.stories) {
        const story = parseDelegatedStory(candidate)
        if (!story || storyIds.has(story.id)) return null
        storyIds.add(story.id)
        addedStories.push(story)
    }
    return { reason, addedStories }
}

/**
 * Revalidate the source-bound event at the Board trust boundary. The model
 * parser is not an authority boundary: a faulty producer or hostile subscriber
 * must not be able to broaden the two-story, add-only conversational policy.
 */
export function validateConversationDelegationProposal(
    value: unknown,
): ConversationDelegationProposalValidation {
    if (
        !isExactRecord(value, [
            "runId",
            "messageId",
            "proposalId",
            "agentId",
            "baseGraphVersion",
            "reason",
            "addedStories",
        ])
    ) {
        return { ok: false, reason: "proposal shape is not exact" }
    }

    const runId = normalizedString(value.runId, 256)
    const messageId = normalizedString(value.messageId, 256)
    const proposalId = normalizedString(value.proposalId, 256)
    const agentId = normalizedString(value.agentId, MAX_ID_LENGTH)
    const reason = normalizedString(value.reason, MAX_REASON_LENGTH)
    if (!runId || !messageId || !proposalId || !agentId || !reason) {
        return { ok: false, reason: "proposal correlation or reason is invalid" }
    }
    if (
        !Number.isSafeInteger(value.baseGraphVersion) ||
        Number(value.baseGraphVersion) < 1
    ) {
        return { ok: false, reason: "base graph version is invalid" }
    }
    if (proposalId !== conversationDelegationProposalId(runId, messageId)) {
        return { ok: false, reason: "proposal id does not match its run and message" }
    }
    if (
        !Array.isArray(value.addedStories) ||
        value.addedStories.length === 0 ||
        value.addedStories.length > MAX_CONVERSATION_DELEGATED_STORIES
    ) {
        return {
            ok: false,
            reason: `conversation delegation must add 1-${MAX_CONVERSATION_DELEGATED_STORIES} stories`,
        }
    }

    const addedStories: ConversationDelegatedStory[] = []
    const storyIds = new Set<string>()
    for (const candidate of value.addedStories) {
        const story = parseBoardDelegatedStory(candidate)
        if (!story || storyIds.has(story.id)) {
            return { ok: false, reason: "delegated story payload is invalid" }
        }
        storyIds.add(story.id)
        addedStories.push(story)
    }

    return {
        ok: true,
        proposal: {
            runId,
            messageId,
            proposalId,
            agentId,
            baseGraphVersion: Number(value.baseGraphVersion),
            reason,
            addedStories,
        },
    }
}

/**
 * Convert a source-bound conversational proposal into the existing durable
 * graph-transaction contract. The synthetic correlation carries no lease
 * authority: Board callers must decide it with `requireActiveLease: false`.
 */
export function toRuntimeReplanProposal(
    data: ConversationDelegationProposedData,
    priorityBase = DEFAULT_CONVERSATION_STORY_PRIORITY,
): RuntimeReplanProposedData {
    if (
        !Number.isInteger(priorityBase) ||
        priorityBase < -2_147_483_648 ||
        priorityBase + data.addedStories.length - 1 > MAX_I32
    ) {
        throw new RangeError("conversation delegation priority base is outside i32 bounds")
    }
    return {
        runId: data.runId,
        proposalId: data.proposalId,
        sourceStoryId: "@conversation",
        leaseId: `conversation:${data.proposalId}`,
        generation: 0,
        baseGraphVersion: data.baseGraphVersion,
        reason: data.reason,
        mutation: {
            addedStories: data.addedStories.map((story, index) => ({
                id: story.id,
                priority: priorityBase + index,
                title: story.title,
                description: story.description,
                dependsOn: [...story.dependsOn],
                retries: 1,
                acceptance: [...story.acceptance],
                tests: [...story.tests],
            })),
            removedStoryIds: [],
            modifiedDeps: {},
        },
    }
}

function parseDelegatedStory(value: unknown): ConversationDelegatedStory | null {
    if (
        !isExactRecord(value, [
            "id",
            "title",
            "description",
            "depends_on",
            "acceptance",
            "tests",
        ])
    ) return null

    const id = normalizedString(value.id, MAX_ID_LENGTH)
    const title = normalizedString(value.title, MAX_TITLE_LENGTH)
    const description = normalizedString(
        value.description,
        MAX_DESCRIPTION_LENGTH,
    )
    const dependsOn = normalizedStringList(value.depends_on, {
        allowEmpty: true,
        itemLimit: MAX_ID_LENGTH,
    })
    const acceptance = normalizedStringList(value.acceptance, {
        allowEmpty: false,
        itemLimit: MAX_LIST_ITEM_LENGTH,
    })
    const tests = normalizedStringList(value.tests, {
        allowEmpty: false,
        itemLimit: MAX_LIST_ITEM_LENGTH,
    })
    if (
        !id ||
        !title ||
        !description ||
        !dependsOn ||
        !acceptance ||
        !tests ||
        dependsOn.includes(id)
    ) return null

    return {
        id,
        title,
        description,
        dependsOn,
        acceptance,
        tests,
    }
}

function parseBoardDelegatedStory(
    value: unknown,
): ConversationDelegatedStory | null {
    if (
        !isExactRecord(value, [
            "id",
            "title",
            "description",
            "dependsOn",
            "acceptance",
            "tests",
        ])
    ) return null

    return parseDelegatedStory({
        id: value.id,
        title: value.title,
        description: value.description,
        depends_on: value.dependsOn,
        acceptance: value.acceptance,
        tests: value.tests,
    })
}

function normalizedString(value: unknown, limit: number): string | null {
    if (typeof value !== "string") return null
    const normalized = value.trim()
    return normalized.length > 0 && normalized.length <= limit
        ? normalized
        : null
}

function normalizedStringList(
    value: unknown,
    options: { allowEmpty: boolean; itemLimit: number },
): string[] | null {
    if (
        !Array.isArray(value) ||
        value.length > MAX_LIST_ITEMS ||
        (!options.allowEmpty && value.length === 0)
    ) return null
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
        const text = normalizedString(item, options.itemLimit)
        if (!text || seen.has(text)) return null
        seen.add(text)
        normalized.push(text)
    }
    return normalized
}

function isExactRecord(
    value: unknown,
    allowedKeys: readonly string[],
): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Object.keys(value)
    return (
        keys.length === allowedKeys.length &&
        keys.every((key) => allowedKeys.includes(key))
    )
}
