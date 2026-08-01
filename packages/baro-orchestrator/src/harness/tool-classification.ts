/**
 * Backend-neutral tool-name classification.
 *
 * Claude uses PascalCase (for example `NotebookEdit`), while OpenAI,
 * Codex, OpenCode and Pi expose lowercase snake_case or plain lowercase
 * names. Normalising punctuation and case keeps observers independent of
 * the selected model backend.
 */

const FILE_MUTATION_TOOLS = new Set([
    "applypatch",
    "createfile",
    "edit",
    "editfile",
    "multiedit",
    "notebookedit",
    "patch",
    "strreplace",
    "strreplacebasededittool",
    "strreplaceeditor",
    "write",
    "writefile",
])

export function normalizeToolName(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

const SHELL_TOOLS = new Set(["bash", "shell", "run", "execute", "terminal"])

/** A tool that runs a command, whatever each harness happens to call it. */
export function isShellTool(name: string): boolean {
    return SHELL_TOOLS.has(normalizeToolName(name))
}

export function isFileMutationTool(name: string): boolean {
    return FILE_MUTATION_TOOLS.has(normalizeToolName(name))
}

/**
 * The file a mutation tool is about to write, or null when the call does not
 * name one.
 *
 * Lives here rather than beside any one consumer: Sentry reads it to detect
 * overlap, merge awareness reads it to tell agents what landed, and a third
 * copy would drift the moment a backend renames a parameter.
 */
export function filePathFromToolCall(args: string): string | null {
    let parsed: Record<string, unknown>
    try {
        parsed = JSON.parse(args) as Record<string, unknown>
    } catch {
        return null
    }
    for (const key of ["file_path", "path", "notebook_path", "filePath"]) {
        const value = parsed[key]
        if (typeof value === "string" && value.trim()) return value.trim()
    }
    return null
}
