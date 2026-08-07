/**
 * Tool layer for the OpenAI-backed StoryAgent: the read tools from
 * `codebase-tools.ts` plus write_file / edit_file. Writes may touch arbitrary
 * paths inside the story worktree (real refactors need that flexibility), but
 * path-prefix and symlink escapes outside the worktree are refused.
 */

import * as fs from "fs"
import * as path from "path"

import { type Tool } from "../../runtime/mozaik.js"

import {
    createCodebaseTools,
    safePath,
    type CodebaseToolOptions,
    type StoryWriteSurface,
} from "./codebase-tools.js"

const MAX_WRITE_BYTES = 500_000

/**
 * NOTE: the shared `bash` tool describes itself as read-only, while the
 * StoryAgent prompt permits in-worktree builds, edits, installs, and commits.
 * On macOS its shell writes are additionally confined by Seatbelt; other
 * platforms currently rely on the conservative command guard fallback.
 */
export function createStoryTools(
    cwd: string,
    options: CodebaseToolOptions = {},
): Tool[] {
    return [
        ...createCodebaseTools(cwd, options),
        writeFileTool(cwd, options.surface),
        editFileTool(cwd, options.surface),
    ]
}

/**
 * The write surface, enforced where the model acts.
 *
 * The story prompt already names every file this story may write, every file
 * another story owns, and the three things to do instead of reaching into one.
 * A live run read all of it and edited four other stories' services anyway:
 * the foundation story wanted to prove its service worked end to end, so it
 * instrumented the consumers. Nothing stopped it, its own test evidence then
 * described a tree it had changed underneath itself, and the Critic could only
 * answer "unverifiable" — one story lost, and the nine that depended on it
 * skipped.
 *
 * Prose is advice to a model that does not have to take it. This is the same
 * boundary as a refusal the model reads in the round it tried, while the edit
 * costs one tool call instead of an hour and a whole level of the plan.
 */
function surfaceRefusal(
    path: string,
    surface: StoryWriteSurface | undefined,
): string | null {
    if (!surface) return null
    const normalized = path.replace(/^\.\//u, "")
    const owner = surface.ownedElsewhere[normalized]
    if (!owner) return null
    return (
        `Error: ${normalized} belongs to story ${owner}, not to this story. ` +
        `A diff touching it is refused at integration, so writing it here ` +
        `loses this whole story rather than just the edit. Ask ${owner} for ` +
        `the change, block on ${owner}, or dispute the contract claim that ` +
        `made you reach for it — see "Your write surface" in your instructions.`
    )
}

/** Outside the declaration but owned by nobody: allowed, and said out loud. */
function surfaceNote(
    path: string,
    surface: StoryWriteSurface | undefined,
): string {
    if (!surface || surface.writes.length === 0) return ""
    const normalized = path.replace(/^\.\//u, "")
    if (surface.writes.includes(normalized)) return ""
    return (
        `\nNote: ${normalized} is not in this story's declared write surface. ` +
        `Nobody else owns it, so this write stands, but the merge gate is the ` +
        `authority on what it accepts.`
    )
}

function writeFileTool(cwd: string, surface?: StoryWriteSurface): Tool {
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
            const refusal = surfaceRefusal(args.path, surface)
            if (refusal) return refusal
            const target = safePath(cwd, args.path)
            if (!target) return `Error: path '${args.path}' escapes the project root.`
            if (args.content.length > MAX_WRITE_BYTES) {
                return `Error: write_file refused — content is ${args.content.length} bytes, max is ${MAX_WRITE_BYTES}. Split the file or use edit_file for partial updates.`
            }
            try {
                const dir = path.dirname(target)
                fs.mkdirSync(dir, { recursive: true })
                fs.writeFileSync(target, args.content, "utf-8")
                return (
                    `Wrote ${args.path} (${args.content.length} bytes).` +
                    surfaceNote(args.path, surface)
                )
            } catch (e) {
                return `Error writing ${args.path}: ${(e as Error)?.message ?? String(e)}`
            }
        },
    }
}

function editFileTool(cwd: string, surface?: StoryWriteSurface): Tool {
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
            const refusal = surfaceRefusal(args.path, surface)
            if (refusal) return refusal
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
                return (
                    `Edited ${args.path} (${sign}${delta} bytes).` +
                    surfaceNote(args.path, surface)
                )
            } catch (e) {
                return `Error writing ${args.path}: ${(e as Error)?.message ?? String(e)}`
            }
        },
    }
}
