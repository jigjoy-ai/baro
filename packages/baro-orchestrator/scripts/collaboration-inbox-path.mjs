const INBOX_NAME_PREFIX = "agent-"

/**
 * Encode an agent/story id as one path-safe, collision-free filename stem.
 *
 * UTF-8 plus canonical base64url keeps path separators and platform-reserved
 * names out of the filesystem component. Baro story ids are JSON strings, so
 * this mapping is reversible for every well-formed Unicode id accepted by the
 * protocol.
 */
export function encodeInboxAgentId(agentId) {
    if (typeof agentId !== "string" || agentId.length === 0) {
        throw new TypeError("inbox agent id must be a non-empty string")
    }
    return INBOX_NAME_PREFIX + Buffer.from(agentId, "utf8").toString("base64url")
}

/** Decode a canonical inbox filename stem, or return null for foreign names. */
export function decodeInboxAgentId(encoded) {
    if (
        typeof encoded !== "string" ||
        !encoded.startsWith(INBOX_NAME_PREFIX)
    ) return null

    const payload = encoded.slice(INBOX_NAME_PREFIX.length)
    if (!payload || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null

    try {
        const decoded = Buffer.from(payload, "base64url").toString("utf8")
        return encodeInboxAgentId(decoded) === encoded ? decoded : null
    } catch {
        return null
    }
}

export function inboxFilenameForAgentId(agentId) {
    return `${encodeInboxAgentId(agentId)}.jsonl`
}
