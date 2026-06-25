/**
 * Codebase-exploration tools for OpenAI-backed planning participants
 * (Architect, Planner, and — later — the OpenAI StoryAgent).
 *
 * Shape: Mozaik 3.9's `FunctionTool`. Bound to a cwd at construction
 * time so the same OpenAIInferenceRunner instance can serve multiple
 * concurrent runs with different roots. All tools refuse to traverse
 * out of cwd via path resolution.
 *
 * NOT used by the Claude side — `claude --print` ships its own
 * Read/Grep/Glob/Bash. These exist only because the OpenAI Responses
 * API expects function definitions to be supplied per request and
 * because we want the Architect/Planner reasoning to be reproducible
 * with the same tool semantics across providers.
 */

import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

import { type Tool } from "@mozaik-ai/core"

const IGNORE = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    "__pycache__",
    "target",
    ".output",
    ".vercel",
])

const MAX_FILE_BYTES = 15_000
const MAX_GREP_LINES = 80
const MAX_BASH_OUTPUT_BYTES = 8_000

export function createCodebaseTools(cwd: string): Tool[] {
    return [
        readFileTool(cwd),
        listFilesTool(cwd),
        fileTreeTool(cwd),
        grepTool(cwd),
        globTool(cwd),
        bashTool(cwd),
    ]
}

function readFileTool(cwd: string): Tool {
    return {
        type: "function",
        name: "read_file",
        description:
            "Read the full contents of a file by path relative to the project root. " +
            "Returns up to 15000 characters (truncates past that). Use to inspect " +
            "package.json, source files, config files, READMEs, etc.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path relative to the project root (e.g. 'src/index.ts').",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
        async invoke(args: { path: string }) {
            const target = safePath(cwd, args.path)
            if (!target) return `Error: path '${args.path}' escapes the project root.`
            if (!fs.existsSync(target)) return `File not found: ${args.path}`
            const stat = fs.statSync(target)
            if (stat.isDirectory()) {
                return `${args.path} is a directory — use list_files or file_tree.`
            }
            if (stat.size > 500_000) {
                return `File too large (${(stat.size / 1024).toFixed(0)} KB) — skip or grep instead.`
            }
            let content = fs.readFileSync(target, "utf-8")
            if (content.length > MAX_FILE_BYTES) {
                content = content.slice(0, MAX_FILE_BYTES) + "\n... (truncated)"
            }
            return content
        },
    }
}

function listFilesTool(cwd: string): Tool {
    return {
        type: "function",
        name: "list_files",
        description:
            "List files and directories at a path. Use path='' for the project root. " +
            "Skips node_modules, .git, dist, build, target, and other dependency dirs.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Directory path relative to the project root. Empty for root.",
                },
                recursive: {
                    type: "boolean",
                    description: "Walk subdirectories up to 4 deep, capped at 200 entries.",
                },
            },
            required: ["path", "recursive"],
            additionalProperties: false,
        },
        async invoke(args: { path: string; recursive: boolean }) {
            const target = safePath(cwd, args.path || ".")
            if (!target) return `Error: path '${args.path}' escapes the project root.`
            if (!fs.existsSync(target)) return `Directory not found: ${args.path}`
            const stat = fs.statSync(target)
            if (!stat.isDirectory()) return `${args.path} is not a directory — use read_file.`

            const results: string[] = []
            function walk(dir: string, prefix: string, depth: number) {
                if (results.length >= 200 || depth > 4) return
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue
                    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
                    if (entry.isDirectory()) {
                        results.push(rel + "/")
                        if (args.recursive) walk(path.join(dir, entry.name), rel, depth + 1)
                    } else {
                        results.push(rel)
                    }
                }
            }
            walk(target, "", 0)
            return results.join("\n") || "(empty directory)"
        },
    }
}

function fileTreeTool(cwd: string): Tool {
    return {
        type: "function",
        name: "file_tree",
        description:
            "Show a condensed ASCII tree of the project structure up to 3 levels deep. " +
            "Cheapest way to get a first overview before deciding which files to read.",
        strict: true,
        parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
        },
        async invoke() {
            const lines: string[] = [path.basename(cwd) + "/"]
            function walk(dir: string, prefix: string, depth: number) {
                if (lines.length >= 150 || depth > 3) return
                let entries: fs.Dirent[]
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true })
                } catch {
                    return
                }
                entries.sort((a, b) => {
                    if (a.isDirectory() && !b.isDirectory()) return -1
                    if (!a.isDirectory() && b.isDirectory()) return 1
                    return a.name.localeCompare(b.name)
                })
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i]!
                    if (IGNORE.has(entry.name) || entry.name.startsWith(".")) continue
                    const isLast = i === entries.length - 1
                    const connector = isLast ? "└── " : "├── "
                    const childPrefix = isLast ? "    " : "│   "
                    if (entry.isDirectory()) {
                        lines.push(`${prefix}${connector}${entry.name}/`)
                        walk(path.join(dir, entry.name), prefix + childPrefix, depth + 1)
                    } else {
                        lines.push(`${prefix}${connector}${entry.name}`)
                    }
                }
            }
            walk(cwd, "", 0)
            return lines.join("\n")
        },
    }
}

function grepTool(cwd: string): Tool {
    return {
        type: "function",
        name: "grep",
        description:
            "Search for a text pattern across project files. Returns matching lines with " +
            "their file paths. Case-insensitive. Skips dependency directories. Caps results at 80 lines.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Text or regex (POSIX) to search for.",
                },
                path: {
                    type: "string",
                    description: "Directory to search in. Default: entire project.",
                },
                file_pattern: {
                    type: "string",
                    description: "File glob filter (e.g. '*.ts', '*.tsx'). Default: all files.",
                },
            },
            required: ["pattern", "path", "file_pattern"],
            additionalProperties: false,
        },
        async invoke(args: { pattern: string; path: string; file_pattern: string }) {
            const searchDir = safePath(cwd, args.path || ".")
            if (!searchDir) return `Error: path '${args.path}' escapes the project root.`
            if (!fs.existsSync(searchDir)) return `Directory not found: ${args.path}`
            try {
                const excludes = Array.from(IGNORE)
                    .map((d) => `--exclude-dir=${d}`)
                    .join(" ")
                const include = args.file_pattern ? `--include='${args.file_pattern}'` : ""
                const cmd = `grep -rn -i ${excludes} ${include} --max-count=50 -- ${JSON.stringify(
                    args.pattern,
                )} ${JSON.stringify(searchDir)} 2>/dev/null || true`
                const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 })
                const lines = output
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => (line.startsWith(cwd) ? line.slice(cwd.length + 1) : line))
                return lines.slice(0, MAX_GREP_LINES).join("\n") || "No matches found."
            } catch {
                return "No matches found."
            }
        },
    }
}

function globTool(cwd: string): Tool {
    return {
        type: "function",
        name: "glob",
        description:
            "List files matching a glob pattern (e.g. 'src/**/*.ts'). Useful when you " +
            "want every file of a type without scanning the whole tree.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Glob pattern relative to the project root.",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        async invoke(args: { pattern: string }) {
            try {
                // Use shell glob via `find` so we don't take a new dep.
                // Translate the most common glob features into find args.
                const cmd = `cd ${JSON.stringify(cwd)} && find . -path './node_modules' -prune -o -path './.git' -prune -o -path './target' -prune -o -path './dist' -prune -o -path './build' -prune -o -type f -print | grep -E ${JSON.stringify(
                    globToRegex(args.pattern),
                )} 2>/dev/null | head -200 || true`
                const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 })
                const lines = output
                    .split("\n")
                    .filter(Boolean)
                    .map((l) => l.replace(/^\.\//, ""))
                return lines.join("\n") || "(no matches)"
            } catch {
                return "(glob failed)"
            }
        },
    }
}

function bashTool(cwd: string): Tool {
    return {
        type: "function",
        name: "bash",
        description:
            "Run a non-destructive read-only shell command in the project root. " +
            "Use for inspections like 'cat package.json | head', 'git log --oneline | head', " +
            "'wc -l src/**/*.ts'. Caps output at 8 KB. Do NOT use for writes, edits, or installs.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute. Read-only operations only.",
                },
            },
            required: ["command"],
            additionalProperties: false,
        },
        async invoke(args: { command: string }) {
            try {
                const output = execSync(args.command, {
                    cwd,
                    encoding: "utf-8",
                    maxBuffer: 4 * 1024 * 1024,
                    // Real builds/test suites (e.g. a Next.js `npm run build`) take minutes;
                    // 30s was far too short. Default 5min, overridable per environment.
                    timeout: Number(process.env.BARO_BASH_TIMEOUT_MS) || 300_000,
                    stdio: ["ignore", "pipe", "pipe"],
                })
                if (output.length > MAX_BASH_OUTPUT_BYTES) {
                    return (
                        output.slice(0, MAX_BASH_OUTPUT_BYTES) +
                        `\n... (truncated, ${output.length - MAX_BASH_OUTPUT_BYTES} bytes elided)`
                    )
                }
                return output || "(empty output)"
            } catch (e) {
                const err = e as { stderr?: Buffer | string; status?: number; message?: string }
                const stderr =
                    err.stderr instanceof Buffer ? err.stderr.toString() : err.stderr ?? ""
                return `bash exited with status ${err.status ?? "?"}: ${stderr || err.message || "unknown error"}`
            }
        },
    }
}

function safePath(cwd: string, filePath: string): string | null {
    const resolved = path.resolve(cwd, filePath)
    if (!resolved.startsWith(path.resolve(cwd))) return null
    return resolved
}

/**
 * Tiny glob → regex translator. Covers `*`, `**`, `?`, and literal
 * characters. Good enough for the common cases ("src/**\/*.ts",
 * "packages/*\/package.json"); falls back to literal matching for
 * anything fancier.
 */
function globToRegex(glob: string): string {
    let regex = "^"
    let i = 0
    while (i < glob.length) {
        const ch = glob[i]!
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                regex += ".*"
                i += 2
                if (glob[i] === "/") i++
                continue
            }
            regex += "[^/]*"
            i++
            continue
        }
        if (ch === "?") {
            regex += "[^/]"
            i++
            continue
        }
        if (ch === ".") {
            regex += "\\."
            i++
            continue
        }
        if ("()[]{}+|^$\\".includes(ch)) {
            regex += "\\" + ch
            i++
            continue
        }
        regex += ch
        i++
    }
    regex += "$"
    return regex
}
