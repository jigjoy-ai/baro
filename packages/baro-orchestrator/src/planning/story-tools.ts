/**
 * Tool layer for the OpenAI-backed StoryAgent: the read tools from
 * `codebase-tools.ts` plus write_file / edit_file. Writes are deliberately
 * not sandboxed to specific paths (real refactors touch arbitrary parts of
 * the tree) — the per-story branch makes anything recoverable via git.
 * write_file / edit_file still refuse paths that resolve outside cwd.
 */

import * as fs from "fs"
import * as path from "path"

import { type Tool } from "@mozaik-ai/core"

import { createCodebaseTools } from "./codebase-tools.js"

const MAX_WRITE_BYTES = 500_000

/**
 * NOTE: the shared `bash` tool describes itself as read-only — a soft
 * convention, not enforced; the StoryAgent system prompt overrides it.
 */
export function createStoryTools(cwd: string): Tool[] {
    return [...createCodebaseTools(cwd), writeFileTool(cwd), editFileTool(cwd)]
}

function writeFileTool(cwd: string): Tool {
    return {
        type: "function",
        name: "write_file",
        description:
            "Create a file or overwrite its full contents. Parent directories are " +
            "created if needed. Use this for new files or when replacing the entire " +
            "body of an existing file is simpler than a series of edits. Caps file " +
            "size at 500 KB.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path relative to the project root.",
                },
                content: {
                    type: "string",
                    description: "Full file contents to write. UTF-8.",
                },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
        async invoke(args: { path: string; content: string }) {
            const target = safePath(cwd, args.path)
            if (!target) return `Error: path '${args.path}' escapes the project root.`
            if (args.content.length > MAX_WRITE_BYTES) {
                return `Error: write_file refused — content is ${args.content.length} bytes, max is ${MAX_WRITE_BYTES}. Split the file or use edit_file for partial updates.`
            }
            try {
                const dir = path.dirname(target)
                fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(target, args.content, "utf-8")
                return `Wrote ${args.path} (${args.content.length} bytes).`
            } catch (e) {
                return `Error writing ${args.path}: ${(e as Error)?.message ?? String(e)}`
            }
        },
    }
}

function editFileTool(cwd: string): Tool {
    return {
        type: "function",
        name: "edit_file",
        description:
            "Find-and-replace a single occurrence of a string in an existing file. " +
            "`old` must appear in the file exactly once (case-sensitive, whitespace " +
            "and newlines included); pass enough surrounding context to make it unique. " +
            "Returns an error if `old` is not found or appears multiple times — at " +
            "that point read_file again and pick a larger snippet.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path relative to the project root.",
                },
                old: {
                    type: "string",
                    description:
                        "Exact text to find. Must be unique in the file. Include " +
                        "surrounding lines if needed to make it unique.",
                },
                new: {
                    type: "string",
                    description: "Replacement text.",
                },
            },
            required: ["path", "old", "new"],
            additionalProperties: false,
        },
        async invoke(args: { path: string; old: string; new: string }) {
            const target = safePath(cwd, args.path)
            if (!target) return `Error: path '${args.path}' escapes the project root.`
            if (!fs.existsSync(target)) {
                return `Error: ${args.path} does not exist. Use write_file to create it.`
            }
            if (fs.statSync(target).isDirectory()) {
                return `Error: ${args.path} is a directory.`
            }
            let original: string
            try {
                original = fs.readFileSync(target, "utf-8")
            } catch (e) {
                return `Error reading ${args.path}: ${(e as Error)?.message ?? String(e)}`
            }

            if (!args.old) return "Error: `old` is empty — refusing to edit."
            const firstIdx = original.indexOf(args.old)
            if (firstIdx === -1) {
                return `Error: \`old\` not found in ${args.path}. Re-read the file and pass an exact-matching snippet (including whitespace).`
            }
            const secondIdx = original.indexOf(args.old, firstIdx + 1)
            if (secondIdx !== -1) {
                return `Error: \`old\` appears multiple times in ${args.path} (first at offset ${firstIdx}, again at ${secondIdx}). Include more surrounding context so the match is unique.`
            }

            const updated =
                original.slice(0, firstIdx) + args.new + original.slice(firstIdx + args.old.length)
            try {
                fs.writeFileSync(target, updated, "utf-8")
                const delta = updated.length - original.length
                const sign = delta >= 0 ? "+" : ""
                return `Edited ${args.path} (${sign}${delta} bytes).`
            } catch (e) {
                return `Error writing ${args.path}: ${(e as Error)?.message ?? String(e)}`
            }
        },
    }
}

function safePath(cwd: string, filePath: string): string | null {
    const resolved = path.resolve(cwd, filePath)
    if (!resolved.startsWith(path.resolve(cwd))) return null
    return resolved
}
