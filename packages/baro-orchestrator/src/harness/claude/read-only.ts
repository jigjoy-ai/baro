import { CREDENTIAL_READ_DENY } from "../os-sandbox.js"

/**
 * Read permissions for a Claude role that only reads (architect, scouts,
 * planner, surgeon). Under dontAsk, Claude Code refuses every read outside
 * its working directory, which hid the references a goal points at (a
 * symlinked SDK, a sibling checkout) from the architect. Reads are approved
 * everywhere instead, except the credential stores the OS sandbox also hides
 * from story lanes; a deny rule wins over the approval, for Grep and Glob too.
 */
export function claudeReadPermissionArgs(extraAllowed: readonly string[] = []): string[] {
    return [
        "--allowedTools",
        ["Read", "Glob", "Grep", ...extraAllowed].join(","),
        "--disallowedTools",
        CREDENTIAL_READ_DENY.flatMap((entry) => [`Read(~/${entry})`, `Read(~/${entry}/**)`]).join(","),
    ]
}

/**
 * Claude Code flags for the roles that only read and answer (architect,
 * planner, surgeon): the read tools, no MCP servers, no slash commands, no
 * session left behind, and nothing that would need an approval runs. These
 * roles run in the user's checkout, so they get no write or shell tool.
 */
export const CLAUDE_READ_ONLY_ARGS: readonly string[] = [
    "--tools",
    "Read,Glob,Grep",
    ...claudeReadPermissionArgs(),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
]
