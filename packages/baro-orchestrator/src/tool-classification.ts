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

export function isFileMutationTool(name: string): boolean {
    return FILE_MUTATION_TOOLS.has(normalizeToolName(name))
}
