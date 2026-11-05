/**
 * Claude Code flags for the roles that only read and answer (architect,
 * planner, surgeon): the read tools, no MCP servers, no slash commands, no
 * session left behind, and nothing that would need an approval runs. These
 * roles run in the user's checkout, so they get no write or shell tool.
 */
export const CLAUDE_READ_ONLY_ARGS: readonly string[] = [
    "--tools",
    "Read,Glob,Grep",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
]
