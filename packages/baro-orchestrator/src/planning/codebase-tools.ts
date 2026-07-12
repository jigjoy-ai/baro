/**
 * Codebase-exploration tools (Mozaik `FunctionTool` shape) for the
 * OpenAI-backed planning participants. Bound to a cwd at construction so
 * one runner instance can serve concurrent runs with different roots;
 * every tool refuses paths that resolve outside cwd. Not used by the
 * Claude side — `claude --print` ships its own Read/Grep/Glob/Bash.
 */

import { execFile, execFileSync, execSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
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

type SignalAwareTool = Tool & {
    invokeWithSignal: (args: any, signal: AbortSignal) => Promise<unknown>
}

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
                // Shell glob via `find` + grep so we don't take a new dep.
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

function bashTool(cwd: string): SignalAwareTool {
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
            return runBash(cwd, args.command)
        },
        async invokeWithSignal(
            args: { command: string },
            signal: AbortSignal,
        ) {
            return runBash(cwd, args.command, signal)
        },
    }
}

function runBash(
    cwd: string,
    command: string,
    signal?: AbortSignal,
): Promise<string> {
    const rejection = bashContainmentRejection(cwd, command)
    if (rejection) {
        return Promise.resolve(
            `Error: bash command rejected by project containment guard: ${rejection}`,
        )
    }

    const sandbox = prepareShellSandbox(cwd, command)

    return new Promise((resolve) => {
        const finish = (value: string): void => {
            sandbox.cleanup()
            resolve(value)
        }
        try {
            const child = execFile(
                sandbox.executable,
                sandbox.args,
                {
                    cwd,
                    encoding: "utf-8",
                    maxBuffer: 4 * 1024 * 1024,
                    env: sandbox.env,
                    // Real builds/test suites take minutes; 30s was far too short.
                    timeout:
                        Number(process.env.BARO_BASH_TIMEOUT_MS) || 300_000,
                    ...(signal ? { signal } : {}),
                },
                (error, stdout, stderr) => {
                    if (error) {
                        const status =
                            typeof error.code === "number" ? error.code : "?"
                        const detail = limitBashOutput(
                            stderr || error.message || "unknown error",
                            true,
                        )
                        finish(
                            `bash exited with status ${status}: ` +
                                detail,
                        )
                        return
                    }
                    finish(limitBashOutput(stdout, false) || "(empty output)")
                },
            )
            // Match the old execSync({ stdio: ["ignore", ...] }) behavior:
            // commands that read stdin must see EOF instead of hanging.
            child.stdin?.end()
        } catch (error) {
            finish(
                `bash exited with status ?: ` +
                    ((error as Error)?.message ?? String(error)),
            )
        }
    })
}

interface PreparedShellSandbox {
    executable: string
    args: string[]
    env: NodeJS.ProcessEnv
    cleanup: () => void
}

/**
 * On macOS, run the shell under Seatbelt with writes confined to the current
 * worktree, a per-command scratch directory, narrowly required Git metadata,
 * Cargo's shared download cache, and manager-owned dependency symlink targets.
 * Other platforms retain the portable command guard above until they gain an
 * equivalent process sandbox.
 */
function prepareShellSandbox(cwd: string, command: string): PreparedShellSandbox {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
        return {
            executable: "/bin/sh",
            args: ["-c", command],
            env: process.env,
            cleanup: () => undefined,
        }
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "baro-story-shell-"))
    const scratchReal = fs.realpathSync.native(scratch)
    const writablePaths = sandboxWritablePaths(cwd, scratchReal)
    const profile = macosWriteSandboxProfile(writablePaths)
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: scratchReal,
        TMP: scratchReal,
        TEMP: scratchReal,
        XDG_CACHE_HOME: path.join(scratchReal, "cache"),
        npm_config_cache: path.join(scratchReal, "npm-cache"),
        YARN_CACHE_FOLDER: path.join(scratchReal, "yarn-cache"),
        pnpm_config_store_dir: path.join(scratchReal, "pnpm-store"),
        PIP_CACHE_DIR: path.join(scratchReal, "pip-cache"),
        COMPOSER_CACHE_DIR: path.join(scratchReal, "composer-cache"),
    }

    return {
        executable: "/usr/bin/sandbox-exec",
        args: ["-p", profile, "/bin/sh", "-c", command],
        env,
        cleanup: () => {
            try {
                fs.rmSync(scratch, { recursive: true, force: true })
            } catch {
                // A killed child may briefly retain a scratch entry. It is
                // under the OS temp directory and will be reclaimed normally.
            }
        },
    }
}

function macosWriteSandboxProfile(writablePaths: string[]): string {
    const filters = writablePaths
        .map((entry) => `        (subpath ${JSON.stringify(entry)})`)
        .join("\n")
    return [
        "(version 1)",
        "(allow default)",
        "(deny file-write*",
        "    (require-not",
        "      (require-any",
        filters,
        "      )",
        "    )",
        ")",
    ].join("\n")
}

function sandboxWritablePaths(cwd: string, scratchReal: string): string[] {
    const rootReal = fs.realpathSync.native(path.resolve(cwd))
    const writable = new Set<string>([rootReal, scratchReal, "/dev/null"])
    const git = gitSandboxPaths(cwd)
    for (const entry of git.paths) writable.add(entry)
    for (const entry of dependencySymlinkTargets(cwd, git.commonWorktreeRoot)) {
        writable.add(entry)
    }
    for (const entry of cargoCachePaths()) writable.add(entry)
    return [...writable]
}

function gitSandboxPaths(cwd: string): {
    paths: string[]
    commonWorktreeRoot: string | null
} {
    try {
        const gitDir = fs.realpathSync.native(
            execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim(),
        )
        const commonRaw = execFileSync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            },
        ).trim()
        const commonDir = fs.realpathSync.native(path.resolve(cwd, commonRaw))
        const paths = [gitDir, path.join(commonDir, "objects")]

        let branch = ""
        try {
            branch = execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim()
        } catch {
            // Detached worktrees update HEAD inside gitDir, already allowed.
        }
        if (branch) {
            const ref = path.join(commonDir, branch)
            const log = path.join(commonDir, "logs", branch)
            paths.push(ref, `${ref}.lock`, log, `${log}.lock`)
        }

        const commonWorktreeRoot =
            path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null
        return { paths, commonWorktreeRoot }
    } catch {
        return { paths: [], commonWorktreeRoot: null }
    }
}

function dependencySymlinkTargets(cwd: string, commonRoot: string | null): string[] {
    if (!commonRoot) return []
    const allowedNames = new Set(["node_modules", ".venv", "vendor"])
    const skipped = new Set([".git", "target", "dist", "build", ".next", "coverage"])
    const targets = new Set<string>()

    const walk = (directory: string, depth: number): void => {
        if (depth < 0) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const candidate = path.join(directory, entry.name)
            if (entry.isSymbolicLink() && allowedNames.has(entry.name)) {
                try {
                    const real = fs.realpathSync.native(candidate)
                    if (pathIsWithin(commonRoot, real)) targets.add(real)
                } catch {
                    // Dangling/untrusted dependency links stay denied.
                }
            } else if (entry.isDirectory() && !skipped.has(entry.name)) {
                walk(candidate, depth - 1)
            }
        }
    }
    walk(path.resolve(cwd), 4)
    return [...targets]
}

function cargoCachePaths(): string[] {
    const home = os.homedir()
    if (!home) return []
    return [
        path.join(home, ".cargo", "registry"),
        path.join(home, ".cargo", "git"),
        path.join(home, ".cargo", ".package-cache"),
        path.join(home, ".cargo", ".global-cache"),
    ]
}

function limitBashOutput(output: string, keepTail: boolean): string {
    if (output.length <= MAX_BASH_OUTPUT_BYTES) return output
    const elided = output.length - MAX_BASH_OUTPUT_BYTES
    return keepTail
        ? `... (${elided} bytes elided)\n` + output.slice(-MAX_BASH_OUTPUT_BYTES)
        : output.slice(0, MAX_BASH_OUTPUT_BYTES) +
              `\n... (truncated, ${elided} bytes elided)`
}

/**
 * Resolve a tool path while keeping both its lexical path and its real on-disk
 * ancestor inside the project root. Checking the nearest existing ancestor is
 * important for writes: the final file may not exist yet, but one of its parent
 * directories can still be a symlink that points outside the worktree.
 *
 * This closes path-prefix and symlink escapes for the native file tools. Shell
 * writes additionally have macOS Seatbelt containment; on other platforms the
 * conservative `bashContainmentRejection` fallback covers known escape shapes.
 */
export function safePath(cwd: string, filePath: string): string | null {
    const root = path.resolve(cwd)
    const resolved = path.resolve(root, filePath)
    if (!pathIsWithin(root, resolved)) return null

    let rootReal: string
    try {
        rootReal = fs.realpathSync.native(root)
    } catch {
        return null
    }

    let existing = resolved
    while (true) {
        try {
            // lstat also sees dangling symlinks. realpath will reject those,
            // rather than treating them as a safe, not-yet-created path.
            fs.lstatSync(existing)
            break
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== "ENOENT" && code !== "ENOTDIR") return null
            const parent = path.dirname(existing)
            if (parent === existing || !pathIsWithin(root, parent)) return null
            existing = parent
        }
    }

    let existingReal: string
    try {
        existingReal = fs.realpathSync.native(existing)
    } catch {
        return null
    }
    if (!pathIsWithin(rootReal, existingReal)) return null

    return resolved
}

function pathIsWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate)
    return (
        relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    )
}

type ShellToken =
    | { kind: "word"; value: string }
    | { kind: "operator"; value: string }

/**
 * Reject command shapes that can plainly leave the worktree. This validator is
 * deliberately conservative and covers the incident class (`cd` to another
 * repo followed by an install), absolute external operands, parent/home
 * traversal, nested shell evaluation, and redirection through escaping
 * symlinks. It is defense in depth under macOS Seatbelt and the portable
 * fail-closed fallback elsewhere, not arbitrary-shell security by itself.
 */
function bashContainmentRejection(cwd: string, command: string): string | null {
    const parsed = tokenizeShell(command)
    if (typeof parsed === "string") return parsed
    if (parsed.length === 0) return "empty commands are not allowed"

    let commandStart = true
    let commandName = ""
    let currentDir = path.resolve(cwd)
    let expectRedirectTarget = false
    let cdAwaitingPath = false
    let shellMayTakeCommandString = false

    for (const token of parsed) {
        if (token.kind === "operator") {
            if (token.value === "<" || token.value === ">" || token.value === ">>") {
                expectRedirectTarget = true
                continue
            }
            if (token.value === "<<" || token.value === "<<<") {
                return "here-documents and here-strings are not allowed"
            }
            commandStart = true
            commandName = ""
            cdAwaitingPath = false
            shellMayTakeCommandString = false
            continue
        }

        const word = token.value
        if (!word) continue

        if (expectRedirectTarget) {
            expectRedirectTarget = false
            const rejected = rejectPathOperand(cwd, currentDir, word, false)
            if (rejected) return `redirection target ${rejected}`
            continue
        }

        if (commandStart && isEnvironmentAssignment(word)) continue

        if (commandStart) {
            commandStart = false
            commandName = path.basename(word)

            // An absolute executable is different from an absolute data path.
            // Existing StoryAgent cancellation tests invoke process.execPath
            // directly. Permit project-local executables and that exact runtime;
            // do not treat an arbitrary executable in another repo as trusted.
            if (path.isAbsolute(word)) {
                if (!safePath(cwd, word) && !isCurrentRuntimeExecutable(word)) {
                    return `absolute command '${word}' is outside the project root`
                }
            } else {
                const rejected = rejectTraversalSpelling(word)
                if (rejected) return rejected
            }

            if (["eval", "source", ".", "exec", "env"].includes(commandName)) {
                return `indirect shell command '${commandName}' is not allowed`
            }
            shellMayTakeCommandString = ["bash", "sh", "zsh", "dash", "ksh"].includes(
                commandName,
            )
            cdAwaitingPath = commandName === "cd"
            continue
        }

        if (shellMayTakeCommandString && (word === "-c" || word.includes("c"))) {
            return `nested '${commandName} -c' commands are not allowed`
        }

        if (cdAwaitingPath) {
            if (word.startsWith("-")) {
                return "cd options and 'cd -' are not allowed"
            }
            const rejected = rejectPathOperand(cwd, currentDir, word, true)
            if (rejected) return `cd target ${rejected}`
            const nextDir = safePath(cwd, path.resolve(currentDir, word))
            if (!nextDir) return `cd target '${word}' escapes the project root`
            try {
                if (!fs.statSync(nextDir).isDirectory()) {
                    return `cd target '${word}' is not a directory`
                }
            } catch {
                return `cd target '${word}' does not exist`
            }
            currentDir = nextDir
            cdAwaitingPath = false
            continue
        }

        const rejected = rejectPathOperand(cwd, currentDir, word, false)
        if (rejected) return rejected
    }

    if (expectRedirectTarget) return "redirection is missing its target"
    if (cdAwaitingPath) return "cd without an explicit project-relative target is not allowed"
    return null
}

function rejectPathOperand(
    root: string,
    currentDir: string,
    word: string,
    requirePath: boolean,
): string | null {
    const candidates = [word]
    const equals = word.indexOf("=")
    if (equals >= 0 && equals + 1 < word.length) candidates.push(word.slice(equals + 1))

    for (const candidate of candidates) {
        const spelling = rejectTraversalSpelling(candidate)
        if (spelling) return spelling

        if (path.isAbsolute(candidate)) {
            if (!safePath(root, candidate)) {
                return `absolute path '${candidate}' escapes the project root`
            }
            continue
        }

        const possiblePath = path.resolve(currentDir, candidate)
        const looksLikePath =
            requirePath ||
            candidate.includes("/") ||
            candidate.startsWith(".") ||
            pathEntryExists(possiblePath)
        if (looksLikePath && !safePath(root, possiblePath)) {
            return `path '${candidate}' escapes the project root (possibly through a symlink)`
        }
    }
    return null
}

function rejectTraversalSpelling(word: string): string | null {
    if (word.startsWith("~") || /(^|=)~/.test(word)) {
        return `home-relative path '${word}' is not allowed`
    }
    if (/(^|[=/])\.\.($|\/)/.test(word)) {
        return `parent traversal '${word}' is not allowed`
    }
    return null
}

function pathEntryExists(candidate: string): boolean {
    try {
        fs.lstatSync(candidate)
        return true
    } catch {
        return false
    }
}

function isCurrentRuntimeExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return fs.realpathSync.native(candidate) === fs.realpathSync.native(process.execPath)
    } catch {
        return false
    }
}

function isEnvironmentAssignment(word: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
}

function tokenizeShell(command: string): ShellToken[] | string {
    const tokens: ShellToken[] = []
    let word = ""
    let quote: "'" | '"' | null = null

    const pushWord = () => {
        if (word) tokens.push({ kind: "word", value: word })
        word = ""
    }

    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!
        if (quote) {
            if (ch === quote) {
                quote = null
                continue
            }
            if (quote === '"' && ch === "\\" && i + 1 < command.length) {
                word += command[++i]!
                continue
            }
            if (quote === '"' && (ch === "`" || ch === "$")) {
                return "shell expansion inside double quotes is not allowed"
            }
            word += ch
            continue
        }

        if (ch === "'" || ch === '"') {
            quote = ch
            continue
        }
        if (ch === "\\" && i + 1 < command.length) {
            word += command[++i]!
            continue
        }
        if (/\s/.test(ch)) {
            pushWord()
            continue
        }
        if (ch === "`" || ch === "$") {
            return "shell expansion and command substitution are not allowed"
        }
        if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
            return "process substitution is not allowed"
        }
        if (";&|<>".includes(ch)) {
            pushWord()
            let operator = ch
            if (command[i + 1] === ch && (ch === "&" || ch === "|" || ch === ">" || ch === "<")) {
                operator += command[++i]!
                if (operator === "<<" && command[i + 1] === "<") operator += command[++i]!
            }
            tokens.push({ kind: "operator", value: operator })
            continue
        }
        word += ch
    }
    if (quote) return "unterminated shell quote"
    pushWord()
    return tokens
}

/** Tiny glob → regex translator: covers `*`, `**`, `?` — enough for the common cases. */
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
