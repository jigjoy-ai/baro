/**
 * Codebase-exploration tools (Mozaik `FunctionTool` shape) for the
 * OpenAI-backed planning participants. Bound to a cwd at construction so
 * one runner instance can serve concurrent runs with different roots;
 * every tool refuses paths that resolve outside cwd. Not used by the
 * Claude side — `claude --print` ships its own Read/Grep/Glob/Bash.
 */

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { type Tool } from "@mozaik-ai/core"

import { execFileCli } from "../exec-file-cli.js"

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
const MAX_GREP_MATCHES_PER_FILE = 50
const MAX_GREP_VISITS = 50_000
const MAX_GREP_FILE_BYTES = 1_000_000
const MAX_GREP_TOTAL_BYTES = 16_000_000
const MAX_GREP_LINE_CHARS = 1_000
const MAX_SEARCH_PATTERN_CHARS = 1_000
const MAX_FILE_PATTERN_CHARS = 512
const MAX_GLOB_VISITS = 50_000
const MAX_GLOB_RESULTS = 200
const MAX_GLOB_MATCH_WORK = 16_000_000
const MAX_BASH_OUTPUT_BYTES = 8_000
const DEFAULT_BASH_TIMEOUT_MS = 300_000
const GIT_DISCOVERY_TIMEOUT_MS = 10_000
const GIT_DISCOVERY_MAX_BUFFER = 1024 * 1024

type GlobToken =
    | Readonly<{ kind: "literal"; value: string }>
    | Readonly<{ kind: "one" | "star" | "globstar" }>

interface BoundedGlobMatcher {
    readonly exhausted: boolean
    test(value: string): boolean
}

type SignalAwareTool = Tool & {
    invokeWithSignal: (args: any, signal: AbortSignal) => Promise<unknown>
}

export interface CodebaseToolOptions {
    /** Set false for inspection-only roles that must never receive a shell. */
    includeBash?: boolean
    /**
     * Exact manager-owned transport used by collective StoryAgents. The shell
     * guard recognizes only the helper executable. The loopback endpoint and
     * lease token are data arguments; no manager-private session path or
     * writable transport directory is exposed to the worker.
     */
    collaboration?: Readonly<{
        commandPath: string
        endpoint: string
        token: string
    }>
}

export function createCodebaseTools(
    cwd: string,
    options: CodebaseToolOptions = {},
): Tool[] {
    const tools: Tool[] = [
        readFileTool(cwd),
        listFilesTool(cwd),
        fileTreeTool(cwd),
        grepTool(cwd),
        globTool(cwd),
    ]
    if (options.includeBash !== false) tools.push(bashTool(cwd, options))
    return tools
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
            "Search for literal text across project files. Returns matching lines with " +
            "their file paths. Case-insensitive. Skips dependency directories. Caps results at 80 lines.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Literal text to search for (case-insensitive).",
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
            if (!boundedSearchText(args.pattern, MAX_SEARCH_PATTERN_CHARS)) {
                return `Error: grep pattern must contain 1-${MAX_SEARCH_PATTERN_CHARS} safe characters.`
            }
            if (
                args.file_pattern &&
                !boundedSearchText(args.file_pattern, MAX_FILE_PATTERN_CHARS)
            ) {
                return `Error: file_pattern must contain at most ${MAX_FILE_PATTERN_CHARS} safe characters.`
            }
            const searchDir = safePath(cwd, args.path || ".")
            if (!searchDir) return `Error: path '${args.path}' escapes the project root.`
            if (!fs.existsSync(searchDir)) return `Directory not found: ${args.path}`

            let fileMatcher: BoundedGlobMatcher | null = null
            try {
                if (args.file_pattern) {
                    fileMatcher = compileBoundedGlob(
                        args.file_pattern.replace(/^\.\//u, ""),
                    )
                }
            } catch (error) {
                return `Error: invalid file_pattern: ${errorMessage(error)}`
            }

            return nativeLiteralSearch(cwd, searchDir, args.pattern, fileMatcher)
        },
    }
}

/**
 * Bounded, shell-free repository search. Keeping this in-process removes the
 * GNU/BSD/Windows `grep` portability split and ensures an operational read
 * failure is never reported as a successful "no matches" result.
 */
function nativeLiteralSearch(
    cwd: string,
    searchPath: string,
    pattern: string,
    fileMatcher: BoundedGlobMatcher | null,
): string {
    const root = path.resolve(cwd)
    const needle = pattern.toLowerCase()
    const matches: string[] = []
    let visits = 0
    let bytesRead = 0
    let truncated = false
    let firstFailure: string | null = null

    const recordFailure = (target: string, error: unknown): void => {
        if (firstFailure !== null) return
        const relative = normalizedRelativePath(root, target)
        firstFailure = `${relative}: ${errorMessage(error)}`
    }

    const searchFile = (target: string): void => {
        if (
            matches.length >= MAX_GREP_LINES ||
            visits >= MAX_GREP_VISITS ||
            bytesRead >= MAX_GREP_TOTAL_BYTES ||
            fileMatcher?.exhausted === true
        ) {
            truncated = true
            return
        }
        visits += 1

        const relative = normalizedRelativePath(root, target)
        const basename = path.basename(target)
        if (
            fileMatcher !== null &&
            !fileMatcher.test(relative) &&
            !fileMatcher.test(basename)
        ) {
            if (fileMatcher.exhausted) truncated = true
            return
        }

        let stat: fs.Stats
        try {
            stat = fs.statSync(target)
        } catch (error) {
            recordFailure(target, error)
            return
        }
        if (!stat.isFile()) return
        if (stat.size > MAX_GREP_FILE_BYTES) return
        if (bytesRead + stat.size > MAX_GREP_TOTAL_BYTES) {
            truncated = true
            return
        }

        let content: Buffer
        try {
            content = fs.readFileSync(target)
        } catch (error) {
            recordFailure(target, error)
            return
        }
        bytesRead += content.byteLength
        // NUL is a cheap, deterministic binary-file signal. Binary payloads
        // should not be decoded into model context.
        if (content.includes(0)) return

        const lines = content.toString("utf8").split(/\r?\n/u)
        let fileMatches = 0
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!
            if (!line.toLowerCase().includes(needle)) continue
            const clipped = line.length > MAX_GREP_LINE_CHARS
                ? `${line.slice(0, MAX_GREP_LINE_CHARS)}... (line truncated)`
                : line
            matches.push(`${relative}:${index + 1}:${clipped}`)
            fileMatches += 1
            if (matches.length >= MAX_GREP_LINES) {
                truncated = true
                return
            }
            if (fileMatches >= MAX_GREP_MATCHES_PER_FILE) break
        }
    }

    const walk = (directory: string): void => {
        if (
            matches.length >= MAX_GREP_LINES ||
            visits >= MAX_GREP_VISITS ||
            bytesRead >= MAX_GREP_TOTAL_BYTES ||
            fileMatcher?.exhausted === true
        ) {
            truncated = true
            return
        }

        let entries: fs.Dirent[]
        try {
            entries = fs
                .readdirSync(directory, { withFileTypes: true })
                .sort((left, right) => left.name.localeCompare(right.name, "en"))
        } catch (error) {
            recordFailure(directory, error)
            return
        }
        for (const entry of entries) {
            if (visits >= MAX_GREP_VISITS) {
                truncated = true
                return
            }
            visits += 1
            if (IGNORE.has(entry.name)) continue
            const target = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                walk(target)
            } else if (entry.isFile()) {
                // searchFile accounts for file reads separately; the entry
                // itself has already consumed the traversal visit above.
                visits -= 1
                searchFile(target)
            }
            // Symlinks and special files are never followed.
            if (matches.length >= MAX_GREP_LINES) return
        }
    }

    let searchStat: fs.Stats
    try {
        searchStat = fs.statSync(searchPath)
    } catch (error) {
        return `Error: search failed: ${errorMessage(error)}`
    }
    if (searchStat.isDirectory()) walk(searchPath)
    else if (searchStat.isFile()) searchFile(searchPath)
    else return `Error: search path is neither a directory nor a regular file.`

    const notes: string[] = []
    if (truncated) notes.push("... (search limit reached)")
    if (firstFailure !== null) {
        notes.push(`... (search incomplete: ${firstFailure})`)
    }
    const suffix = notes.length > 0 ? `\n${notes.join("\n")}` : ""
    if (matches.length > 0) return matches.join("\n") + suffix
    if (firstFailure !== null) return `Error: search incomplete: ${firstFailure}`
    return truncated
        ? "No matches found before the search limit was reached."
        : "No matches found."
}

function normalizedRelativePath(root: string, target: string): string {
    const relative = path.relative(root, target) || path.basename(target)
    return relative.split(path.sep).join("/")
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message
    return String(error)
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
            if (!boundedSearchText(args.pattern, MAX_FILE_PATTERN_CHARS)) {
                return `Error: glob pattern must contain 1-${MAX_FILE_PATTERN_CHARS} safe characters.`
            }
            try {
                const matcher = compileBoundedGlob(args.pattern.replace(/^\.\//u, ""))
                const results: string[] = []
                let visits = 0
                const walk = (directory: string, prefix: string): void => {
                    if (
                        results.length >= MAX_GLOB_RESULTS ||
                        visits >= MAX_GLOB_VISITS ||
                        matcher.exhausted
                    ) return
                    const entries = fs
                        .readdirSync(directory, { withFileTypes: true })
                        .sort((left, right) => left.name.localeCompare(right.name, "en"))
                    for (const entry of entries) {
                        visits += 1
                        if (visits > MAX_GLOB_VISITS) return
                        if (IGNORE.has(entry.name)) continue
                        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
                        const absolute = path.join(directory, entry.name)
                        if (entry.isDirectory()) {
                            walk(absolute, relative)
                            if (matcher.exhausted) return
                        } else if (entry.isFile()) {
                            if (matcher.test(relative)) {
                                results.push(relative)
                                if (results.length >= MAX_GLOB_RESULTS) return
                            }
                            if (matcher.exhausted) return
                        }
                        // Symlinks and special files are never followed.
                    }
                }
                walk(path.resolve(cwd), "")
                if (matcher.exhausted) {
                    return results.length > 0
                        ? `${results.join("\n")}\n... (glob matching limit reached)`
                        : "Error: glob matching limit reached."
                }
                return results.join("\n") || "(no matches)"
            } catch {
                return "(glob failed)"
            }
        },
    }
}

function bashTool(cwd: string, options: CodebaseToolOptions): SignalAwareTool {
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
            return runBash(cwd, args.command, options)
        },
        async invokeWithSignal(
            args: { command: string },
            signal: AbortSignal,
        ) {
            return runBash(cwd, args.command, options, signal)
        },
    }
}

async function runBash(
    cwd: string,
    command: string,
    options: CodebaseToolOptions,
    signal?: AbortSignal,
): Promise<string> {
    const access = shellAccessContext(cwd, options)
    const rejection = bashContainmentRejection(cwd, command, access)
    if (rejection) {
        return Promise.resolve(
            `Error: bash command rejected by project containment guard: ${rejection}`,
        )
    }

    const sandbox = prepareShellSandbox(cwd, command, access)
    const configuredTimeout = Number(process.env.BARO_BASH_TIMEOUT_MS)
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_BASH_TIMEOUT_MS
    try {
        const { stdout } = await execFileCli(
            sandbox.executable,
            sandbox.args,
            {
                cwd,
                env: sandbox.env,
                maxBuffer: 4 * 1024 * 1024,
                // Real builds/test suites take minutes; 30s was far too short.
                timeout,
                signal,
            },
        )
        return limitBashOutput(stdout, false) || "(empty output)"
    } catch (error) {
        const failure = error as Error & {
            code?: string | number | null
            stderr?: string
        }
        const status = typeof failure.code === "number" ? failure.code : "?"
        const detail = limitBashOutput(
            failure.stderr || failure.message || "unknown error",
            true,
        )
        return `bash exited with status ${status}: ${detail}`
    } finally {
        // execFileCli rejects only after its ManagedProcessTree has drained, so
        // no descendant can still be using the per-command Seatbelt scratch.
        sandbox.cleanup()
    }
}

interface PreparedShellSandbox {
    executable: string
    args: string[]
    env: NodeJS.ProcessEnv
    cleanup: () => void
}

interface CollaborationShellAccess {
    commandPath: string
    commandReal: string
}

interface ShellAccessContext {
    git: ReturnType<typeof gitSandboxPaths>
    dependencyTargets: string[]
    collaboration: CollaborationShellAccess | null
}

function shellAccessContext(
    cwd: string,
    options: CodebaseToolOptions,
): ShellAccessContext {
    const git = gitSandboxPaths(cwd)
    return {
        git,
        dependencyTargets: dependencySymlinkTargets(
            cwd,
            git.commonWorktreeRoot,
        ),
        collaboration: resolveCollaborationShellAccess(options.collaboration),
    }
}

function resolveCollaborationShellAccess(
    collaboration: CodebaseToolOptions["collaboration"],
): CollaborationShellAccess | null {
    if (!collaboration) return null
    try {
        const commandPath = path.resolve(collaboration.commandPath)
        const commandStat = fs.statSync(commandPath)
        if (!commandStat.isFile()) return null
        const endpoint = new URL(collaboration.endpoint)
        if (
            endpoint.protocol !== "http:" ||
            endpoint.hostname !== "127.0.0.1" ||
            endpoint.username ||
            endpoint.password ||
            endpoint.pathname !== "/" ||
            endpoint.search ||
            endpoint.hash ||
            !/^\d+$/u.test(endpoint.port) ||
            !/^[A-Za-z0-9_-]{32,256}$/u.test(collaboration.token)
        ) return null
        return {
            commandPath,
            commandReal: fs.realpathSync.native(commandPath),
        }
    } catch {
        // A missing/replaced helper or malformed capability fails closed.
        return null
    }
}

/**
 * On macOS, run the shell under Seatbelt with writes confined to the current
 * worktree, a per-command scratch directory, narrowly required Git metadata,
 * and Cargo's shared download cache. Collaboration is loopback HTTP and needs
 * no filesystem write exception.
 * Manager-owned dependency symlink targets remain readable but are deliberately
 * omitted from the write allow-list. Other platforms retain the portable
 * command guard above until they gain an equivalent process sandbox.
 */
function prepareShellSandbox(
    cwd: string,
    command: string,
    access: ShellAccessContext,
): PreparedShellSandbox {
    const inheritedEnv = containedShellEnvironment(process.env)
    if (!hasMacosWriteSandbox()) {
        return {
            executable: "/bin/sh",
            args: ["-c", command],
            env: inheritedEnv,
            cleanup: () => undefined,
        }
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "baro-story-shell-"))
    const scratchReal = fs.realpathSync.native(scratch)
    const writablePaths = sandboxWritablePaths(cwd, scratchReal, access)
    const profile = macosWriteSandboxProfile(writablePaths)
    const env: NodeJS.ProcessEnv = {
        ...inheritedEnv,
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

/** Provider/control-plane credentials never belong in model-authored shells. */
function containedShellEnvironment(
    source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [name, value] of Object.entries(source)) {
        if (isSensitiveEnvironmentName(name)) continue
        env[name] = value
    }
    return env
}

function isSensitiveEnvironmentName(name: string): boolean {
    return (
        /^(?:ANTHROPIC|JIGJOY|OPENAI)_API_KEY$/i.test(name) ||
        /^BARO_OPENAI_KEY_/i.test(name) ||
        /(?:^|_)(?:ACCESS_?KEY|API_?KEY|AUTH_?TOKEN|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET(?:_?KEY)?|SESSION_?TOKEN|TOKEN)$/i.test(
            name,
        )
    )
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

function sandboxWritablePaths(
    cwd: string,
    scratchReal: string,
    access: ShellAccessContext,
): string[] {
    const rootReal = fs.realpathSync.native(path.resolve(cwd))
    const writable = new Set<string>([rootReal, scratchReal, "/dev/null"])
    for (const entry of access.git.paths) writable.add(entry)
    // WorktreeManager-owned dependency links are read-only from StoryAgents.
    // Seatbelt resolves a write through the lexical in-worktree symlink to its
    // external real target, which is intentionally absent from this allow-list.
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
                timeout: GIT_DISCOVERY_TIMEOUT_MS,
                maxBuffer: GIT_DISCOVERY_MAX_BUFFER,
            }).trim(),
        )
        const commonRaw = execFileSync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: GIT_DISCOVERY_TIMEOUT_MS,
                maxBuffer: GIT_DISCOVERY_MAX_BUFFER,
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
                timeout: GIT_DISCOVERY_TIMEOUT_MS,
                maxBuffer: GIT_DISCOVERY_MAX_BUFFER,
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
                    const relative = path.relative(path.resolve(cwd), candidate)
                    const managerTarget = fs.realpathSync.native(
                        path.join(commonRoot, relative),
                    )
                    if (
                        pathIsWithin(commonRoot, real) &&
                        real === managerTarget
                    ) targets.add(real)
                } catch {
                    // Dangling links and same-named links that do not point to
                    // WorktreeManager's corresponding common-root path stay denied.
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

function boundedSearchText(value: unknown, maximum: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= maximum &&
        !/[\u0000-\u001f\u007f]/u.test(value)
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
function bashContainmentRejection(
    cwd: string,
    command: string,
    access: ShellAccessContext,
): string | null {
    const parsed = tokenizeShell(command)
    if (typeof parsed === "string") return parsed
    if (parsed.length === 0) return "empty commands are not allowed"

    let commandStart = true
    let commandName = ""
    let currentDir = path.resolve(cwd)
    let expectRedirectTarget = false
    let cdAwaitingPath = false
    let shellMayTakeCommandString = false
    let opaqueArgumentPending = false
    let opaqueInterpreter: OpaqueInterpreter | null = null
    let collaborationInvocation = false
    const canSandboxOpaqueCode = hasMacosWriteSandbox()

    for (const token of parsed) {
        if (token.kind === "operator") {
            if (
                token.value === "<" ||
                token.value === ">" ||
                token.value === ">>" ||
                token.value === "<&" ||
                token.value === ">&"
            ) {
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
            opaqueArgumentPending = false
            opaqueInterpreter = null
            collaborationInvocation = false
            continue
        }

        const word = token.value
        if (!word) continue

        if (expectRedirectTarget) {
            expectRedirectTarget = false
            const rejected = rejectPathOperand(
                cwd,
                currentDir,
                word,
                false,
                access,
                true,
                false,
            )
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

            if (
                [
                    "builtin",
                    "command",
                    "declare",
                    "env",
                    "eval",
                    "exec",
                    "export",
                    "nice",
                    "nohup",
                    "printenv",
                    "set",
                    "source",
                    "time",
                    "typeset",
                    "xargs",
                    ".",
                ].includes(commandName)
            ) {
                return `indirect shell command '${commandName}' is not allowed`
            }
            shellMayTakeCommandString = ["bash", "sh", "zsh", "dash", "ksh"].includes(
                commandName,
            )
            opaqueInterpreter = classifyOpaqueInterpreter(commandName)
            cdAwaitingPath = commandName === "cd"
            continue
        }

        if (opaqueArgumentPending) {
            opaqueArgumentPending = false
            continue
        }

        if (opaqueInterpreter) {
            const opaqueInlineCode = classifyOpaqueInlineCodeFlag(
                opaqueInterpreter,
                word,
            )
            if (opaqueInlineCode) {
                if (!canSandboxOpaqueCode) {
                    return (
                        `${opaqueInterpreter.label} inline code flags ` +
                        "require the macOS write sandbox"
                    )
                }
                opaqueArgumentPending = opaqueInlineCode === "next-argument"
                continue
            }
        }

        if (commandName === "git" && isGitMessageFlag(word)) {
            opaqueArgumentPending = word === "-m" || word === "--message"
            continue
        }

        if (
            opaqueInterpreter?.kind === "node" &&
            !collaborationInvocation &&
            matchesTrustedFile(word, access.collaboration)
        ) {
            collaborationInvocation = true
            continue
        }

        if (shellMayTakeCommandString && (word === "-c" || word.includes("c"))) {
            return `nested '${commandName} -c' commands are not allowed`
        }

        if (cdAwaitingPath) {
            if (word.startsWith("-")) {
                return "cd options and 'cd -' are not allowed"
            }
            const rejected = rejectPathOperand(
                cwd,
                currentDir,
                word,
                true,
                access,
                false,
                false,
            )
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

        const rejected = rejectPathOperand(
            cwd,
            currentDir,
            word,
            false,
            access,
            false,
            canSandboxOpaqueCode,
        )
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
    access: ShellAccessContext,
    allowDevNull: boolean,
    allowManagerDependency: boolean,
): string | null {
    const candidates = [word]
    const equals = word.indexOf("=")
    if (equals >= 0 && equals + 1 < word.length) candidates.push(word.slice(equals + 1))

    for (const candidate of candidates) {
        const spelling = rejectTraversalSpelling(candidate)
        if (spelling) return spelling

        if (path.isAbsolute(candidate)) {
            if (allowDevNull && candidate === "/dev/null") continue
            if (
                !safePath(root, candidate) &&
                !(
                    allowManagerDependency &&
                    isManagerDependencyPath(
                        root,
                        candidate,
                        access.dependencyTargets,
                    )
                )
            ) {
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
        if (
            looksLikePath &&
            !safePath(root, possiblePath) &&
            !(
                allowManagerDependency &&
                isManagerDependencyPath(
                    root,
                    possiblePath,
                    access.dependencyTargets,
                )
            )
        ) {
            return `path '${candidate}' escapes the project root (possibly through a symlink)`
        }
    }
    return null
}

type OpaqueInterpreter = Readonly<{
    kind: "node" | "python" | "perl" | "ruby"
    label: string
}>

type OpaqueInlineCodeFlag = "next-argument" | "attached-code"

/**
 * Inline evaluator source is an opaque, model-authored program rather than a
 * path the portable guard can validate. Seatbelt can safely contain it on
 * macOS; without an equivalent process write sandbox we must fail closed.
 * Versioned interpreter names are included because package managers commonly
 * expose only `python3`, `python3.12`, or versioned Perl/Ruby shims.
 */
function classifyOpaqueInterpreter(commandName: string): OpaqueInterpreter | null {
    if (commandName === "node" || commandName === path.basename(process.execPath)) {
        return { kind: "node", label: "node" }
    }
    if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/iu.test(commandName) || /^py(?:\.exe)?$/iu.test(commandName)) {
        return { kind: "python", label: "python" }
    }
    if (/^perl(?:\d+(?:\.\d+)*)?(?:\.exe)?$/iu.test(commandName)) {
        return { kind: "perl", label: "perl" }
    }
    if (/^ruby(?:\d+(?:\.\d+)*)?(?:\.exe)?$/iu.test(commandName)) {
        return { kind: "ruby", label: "ruby" }
    }
    return null
}

function classifyOpaqueInlineCodeFlag(
    interpreter: OpaqueInterpreter,
    word: string,
): OpaqueInlineCodeFlag | null {
    switch (interpreter.kind) {
        case "node":
            return classifyNodeInlineCodeFlag(word)
        case "python":
            return classifyPythonInlineCodeFlag(word)
        case "perl":
            return classifyPerlInlineCodeFlag(word)
        case "ruby":
            return classifyRubyInlineCodeFlag(word)
    }
}

function classifyNodeInlineCodeFlag(word: string): OpaqueInlineCodeFlag | null {
    if (
        word === "-e" ||
        word === "-p" ||
        word === "-ep" ||
        word === "-pe" ||
        word === "--eval" ||
        word === "--print"
    ) {
        return "next-argument"
    }
    if (word.startsWith("--eval=") || word.startsWith("--print=")) {
        return "attached-code"
    }

    // Fail closed for compact short-option spellings accepted by some Node
    // versions/wrappers: `-eCODE`, `-pCODE`, `-peCODE`, and `-epCODE`.
    // The exact `-pe`/`-ep` cases above consume the following code argument.
    if (/^-(?:e|p|ep|pe).+/.test(word)) return "attached-code"
    return null
}

/**
 * Python's -W/-X/-Q/-m switches own the remainder of their token. Every other
 * ordinary short switch can be bundled before -c, so continue scanning it.
 */
function classifyPythonInlineCodeFlag(word: string): OpaqueInlineCodeFlag | null {
    if (!word.startsWith("-") || word.startsWith("--")) return null
    const option = word.slice(1)
    for (let index = 0; index < option.length; index += 1) {
        const character = option[index]!
        if (character === "c") {
            return index + 1 === option.length
                ? "next-argument"
                : "attached-code"
        }
        if ("mQWX".includes(character)) return null
        if (!/[A-Za-z0-9]/u.test(character)) return null
    }
    return null
}

/**
 * Perl has both arbitrary-rest operands and constrained optional operands.
 * `-Ivendor`/`-MModule` own their complete remainder, but `-0`, `-d`, and `-V`
 * consume only octal/colon-prefixed data. Continuing after that constrained
 * data is essential: real Perl parses `-0777e`, `-de`, and `-Ve` as -e.
 */
function classifyPerlInlineCodeFlag(word: string): OpaqueInlineCodeFlag | null {
    if (!word.startsWith("-") || word.startsWith("--")) return null
    const option = word.slice(1)
    for (let index = 0; index < option.length; index += 1) {
        const character = option[index]!
        if (character === "e" || character === "E") {
            return index + 1 === option.length
                ? "next-argument"
                : "attached-code"
        }

        // These switches accept an arbitrary attached operand. Any e/E in the
        // remainder belongs to that operand rather than an evaluator bundle.
        if ("FIMimx".includes(character)) return null

        if (character === "0") {
            if (option[index + 1] === "x") {
                index += 1
                while (/[0-9A-Fa-f]/u.test(option[index + 1] ?? "")) index += 1
            } else {
                while (/[0-7]/u.test(option[index + 1] ?? "")) index += 1
            }
            continue
        }
        if (character === "d" || character === "V") {
            if (option[index + 1] === ":") return null
            continue
        }

        // -C's Unicode stream-selection list legitimately contains e/E; -D's
        // diagnostic list is similarly an attached option language.
        if (character === "C" || character === "D") return null
        if (!/[A-Za-z0-9]/u.test(character)) return null
    }
    return null
}

/**
 * Ruby's -0/-T/-W/-K operands are constrained rather than arbitrary. Consume
 * only their valid prefix, then keep scanning so -e cannot hide behind them.
 * For example Ruby executes all of `-0e`, `-W0e`, and `-Kue` as inline code.
 */
function classifyRubyInlineCodeFlag(word: string): OpaqueInlineCodeFlag | null {
    if (!word.startsWith("-") || word.startsWith("--")) return null
    const option = word.slice(1)
    for (let index = 0; index < option.length; index += 1) {
        const character = option[index]!
        if (character === "e") {
            return index + 1 === option.length
                ? "next-argument"
                : "attached-code"
        }

        // Directory, encoding, pattern, extension, load-path, and require
        // options own their arbitrary attached remainder.
        if ("CEFIirx".includes(character)) return null

        if (character === "0" || character === "T") {
            while (/[0-7]/u.test(option[index + 1] ?? "")) index += 1
            continue
        }
        if (character === "K") {
            // Legacy -K consumes exactly one attached kcode character. Ruby
            // accepts punctuation here too: `-K-e` is -K(-) followed by -e.
            if (option[index + 1] !== undefined) index += 1
            continue
        }
        if (character === "W") {
            if (option[index + 1] === ":") return null
            if (/^[0-2]$/u.test(option[index + 1] ?? "")) index += 1
            continue
        }
        if (!/[A-Za-z0-9]/u.test(character)) return null
    }
    return null
}

function hasMacosWriteSandbox(): boolean {
    return process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")
}

function isGitMessageFlag(word: string): boolean {
    return (
        word === "-m" ||
        word.startsWith("-m") ||
        word === "--message" ||
        word.startsWith("--message=")
    )
}

function matchesTrustedFile(
    candidate: string,
    collaboration: CollaborationShellAccess | null,
): boolean {
    if (!collaboration || !path.isAbsolute(candidate)) return false
    const resolved = path.resolve(candidate)
    if (resolved === collaboration.commandPath) return true
    try {
        return fs.realpathSync.native(resolved) === collaboration.commandReal
    } catch {
        return false
    }
}

/**
 * Dependency links are created by WorktreeManager and point back into the
 * common Git worktree. Permit paths only through that lexical link in the
 * isolated story root; passing the real external target directly stays denied.
 */
function isManagerDependencyPath(
    root: string,
    candidate: string,
    dependencyTargets: readonly string[],
): boolean {
    if (dependencyTargets.length === 0) return false
    const rootResolved = path.resolve(root)
    const candidateResolved = path.resolve(candidate)
    if (!pathIsWithin(rootResolved, candidateResolved)) return false

    let existing = candidateResolved
    while (true) {
        try {
            fs.lstatSync(existing)
            break
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== "ENOENT" && code !== "ENOTDIR") return false
            const parent = path.dirname(existing)
            if (parent === existing || !pathIsWithin(rootResolved, parent)) {
                return false
            }
            existing = parent
        }
    }

    try {
        const real = fs.realpathSync.native(existing)
        return dependencyTargets.some((target) => pathIsWithin(target, real))
    } catch {
        return false
    }
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
            if (quote === '"' && ch === "$" && command[i + 1] === "?") {
                // Expanding the immediately preceding exit status cannot
                // disclose a path or redirect a filesystem operation.
                word += "$?"
                i++
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
        if (ch === "$" && command[i + 1] === "?") {
            word += "$?"
            i++
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
            if (
                (ch === ">" || ch === "<") &&
                command[i + 1] === "&"
            ) {
                operator += command[++i]!
            } else if (command[i + 1] === ch && (ch === "&" || ch === "|" || ch === ">" || ch === "<")) {
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

/**
 * Compile the small supported glob language without constructing a
 * backtracking regular expression. Model-controlled patterns therefore have
 * deterministic work bounds even for inputs such as `*a*a*a...`.
 */
function compileBoundedGlob(glob: string): BoundedGlobMatcher {
    const tokens: GlobToken[] = []
    let i = 0
    while (i < glob.length) {
        const ch = glob[i]!
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                if (tokens.at(-1)?.kind !== "globstar") {
                    tokens.push(Object.freeze({ kind: "globstar" }))
                }
                i += 2
                // Preserve the former `**/` behavior: the slash is optional,
                // so both `src/file.ts` and `src/nested/file.ts` match.
                if (glob[i] === "/") i++
                continue
            }
            if (tokens.at(-1)?.kind !== "star" && tokens.at(-1)?.kind !== "globstar") {
                tokens.push(Object.freeze({ kind: "star" }))
            }
            i++
            continue
        }
        if (ch === "?") {
            tokens.push(Object.freeze({ kind: "one" }))
            i++
            continue
        }
        tokens.push(Object.freeze({ kind: "literal", value: ch }))
        i++
    }

    let remainingWork = MAX_GLOB_MATCH_WORK
    let exhausted = false
    return {
        get exhausted() {
            return exhausted
        },
        test(value: string): boolean {
            if (exhausted) return false
            const work = Math.max(1, tokens.length) * (value.length + 1)
            if (work > remainingWork) {
                exhausted = true
                return false
            }
            remainingWork -= work
            return matchGlobTokens(tokens, value)
        },
    }
}

/** Dynamic-programming wildcard match: O(pattern length × path length). */
function matchGlobTokens(tokens: readonly GlobToken[], value: string): boolean {
    let previous = new Uint8Array(value.length + 1)
    let current = new Uint8Array(value.length + 1)
    previous[0] = 1

    for (const token of tokens) {
        current.fill(0)
        if (token.kind === "star" || token.kind === "globstar") {
            current[0] = previous[0]!
            for (let position = 1; position <= value.length; position += 1) {
                const canExtend = token.kind === "globstar" || value[position - 1] !== "/"
                current[position] = previous[position] === 1 ||
                    (canExtend && current[position - 1] === 1)
                    ? 1
                    : 0
            }
        } else {
            for (let position = 0; position < value.length; position += 1) {
                if (previous[position] !== 1) continue
                const character = value[position]!
                if (
                    (token.kind === "one" && character !== "/") ||
                    (token.kind === "literal" && character === token.value)
                ) {
                    current[position + 1] = 1
                }
            }
        }
        const swap = previous
        previous = current
        current = swap
    }
    return previous[value.length] === 1
}
