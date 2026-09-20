/**
 * The shell containment rule, owned once and enforced in two lanes: the
 * native bash tool calls it in-process, and the Claude lane's PreToolUse
 * hook runs these same functions, serialized by shellContainmentHookSource().
 * Everything the rule's call graph reads must therefore be a parameter or
 * another function emitted into that source, and a new module import must be
 * added to shellContainmentHookSource() in the same change.
 */

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

/**
 * Exact manager-owned transport used by collective StoryAgents; the rule
 * recognizes only the helper executable it names.
 */
export interface ShellCollaborationCapability {
    commandPath: string
    endpoint: string
    token: string
}

interface ShellAccessOptions {
    collaboration?: Readonly<ShellCollaborationCapability>
}

/**
 * Values the rule reads are functions, not module consts: the hook source is
 * built from fn.toString(), and a bundler-renamed const would leave that
 * source referring to a name it never declares.
 */
function gitDiscoveryBounds(): { timeout: number; maxBuffer: number } {
    return { timeout: 10_000, maxBuffer: 1024 * 1024 }
}

function shellContainmentGateToken(): string {
    return "[gate:shell-containment]"
}

/**
 * Refusals carry the gate id so a hook denial and the registry's disclosure
 * join on one rule.
 */
export function shellContainmentRefusal(
    cwd: string,
    command: string,
    access: ShellAccessContext,
): string | null {
    const reason = containmentRejection(cwd, command, access)
    return reason === null ? null : `${shellContainmentGateToken()} ${reason}`
}

interface CollaborationShellAccess {
    commandPath: string
    commandReal: string
}

export interface ShellAccessContext {
    git: ReturnType<typeof gitSandboxPaths>
    dependencyTargets: string[]
    collaboration: CollaborationShellAccess | null
}

export function shellAccessContext(
    cwd: string,
    options: ShellAccessOptions,
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
    collaboration: Readonly<ShellCollaborationCapability> | undefined,
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

function gitSandboxPaths(cwd: string): {
    paths: string[]
    commonWorktreeRoot: string | null
} {
    const { timeout, maxBuffer } = gitDiscoveryBounds()
    try {
        const gitDir = fs.realpathSync.native(
            execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout,
                maxBuffer,
            }).trim(),
        )
        const commonRaw = execFileSync(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            {
                cwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout,
                maxBuffer,
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
                timeout,
                maxBuffer,
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

/**
 * Resolve a tool path while keeping both its lexical path and its real on-disk
 * ancestor inside the project root. Checking the nearest existing ancestor is
 * important for writes: the final file may not exist yet, but one of its parent
 * directories can still be a symlink that points outside the worktree.
 *
 * This closes path-prefix and symlink escapes for the native file tools. Shell
 * writes additionally have macOS Seatbelt containment; on other platforms the
 * conservative `shellContainmentRefusal` fallback covers known escape shapes.
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
function containmentRejection(
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

        if (
            (commandName === "sed" || commandName === "awk") &&
            isSedAwkScriptOperand(word)
        ) {
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

/**
 * `sed`/`awk` addresses and scripts (`/panicked/,+8p`, `/start/,/end/p`)
 * begin with `/` but are not file paths. Only exempt suffix shapes that are
 * plainly sed/awk syntax, not arbitrary text after a leading slash.
 */
function isSedAwkScriptOperand(word: string): boolean {
    if (!word.startsWith("/")) return false
    let closingIndex = -1
    for (let i = 1; i < word.length; i++) {
        if (word[i] === "/" && word[i - 1] !== "\\") {
            closingIndex = i
            break
        }
    }
    if (closingIndex < 0) return false
    const suffix = word.slice(closingIndex + 1)
    return (
        suffix === "" ||
        suffix.startsWith(",") ||
        suffix.startsWith("!") ||
        /^\s*\{/.test(suffix) ||
        /^[pdqnNDPhHgGxl=zZF][;}!]?$/.test(suffix) ||
        /^[sy][^A-Za-z0-9]/.test(suffix)
    )
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

export function hasMacosWriteSandbox(): boolean {
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
 * The orchestrator hands the hook its worktree and the collaboration helper
 * through containment.json, so the capability's endpoint and token — which
 * the native lane revalidates because a model can reach the options object —
 * are not repeated here. The rule applied to the result is the same function.
 */
export function hookShellAccessContext(
    root: string,
    collabCommandPath: string | null,
): ShellAccessContext {
    const access = shellAccessContext(root, {})
    if (!collabCommandPath || !path.isAbsolute(collabCommandPath)) return access
    try {
        const commandPath = path.resolve(collabCommandPath)
        if (!fs.statSync(commandPath).isFile()) return access
        return {
            ...access,
            collaboration: {
                commandPath,
                commandReal: fs.realpathSync.native(commandPath),
            },
        }
    } catch {
        return access
    }
}

const HOOK_SOURCE_GRAPH: ReadonlyArray<(...args: never[]) => unknown> = [
    gitDiscoveryBounds,
    shellContainmentGateToken,
    pathIsWithin,
    pathEntryExists,
    safePath,
    rejectTraversalSpelling,
    isCurrentRuntimeExecutable,
    isManagerDependencyPath,
    matchesTrustedFile,
    isGitMessageFlag,
    isEnvironmentAssignment,
    isSedAwkScriptOperand,
    hasMacosWriteSandbox,
    classifyNodeInlineCodeFlag,
    classifyPythonInlineCodeFlag,
    classifyPerlInlineCodeFlag,
    classifyRubyInlineCodeFlag,
    classifyOpaqueInlineCodeFlag,
    classifyOpaqueInterpreter,
    rejectPathOperand,
    tokenizeShell,
    containmentRejection,
    shellContainmentRefusal,
    gitSandboxPaths,
    dependencySymlinkTargets,
    resolveCollaborationShellAccess,
    shellAccessContext,
    hookShellAccessContext,
]

function hookDeclaration(fn: (...args: never[]) => unknown): string {
    const source = fn.toString()
    // A bundler may hand back a bare function expression (esbuild's keepNames
    // wrapper); binding it to fn.name keeps every cross-reference resolvable.
    return /^(?:async\s+)?function\b/u.test(source)
        ? source
        : `const ${fn.name} = ${source}`
}

/**
 * The rule as standalone ESM, for a lane that cannot import this module: in
 * development the orchestrator runs as TypeScript under tsx, in production it
 * is a bundle with no separate module files. Serializing the real functions is
 * what keeps the two enforcement sites from drifting into two rules.
 */
export function shellContainmentHookSource(): string {
    return [
        `import fs from "node:fs"`,
        `import path from "node:path"`,
        `import { execFileSync } from "node:child_process"`,
        `const __name = (fn) => fn`,
        ...HOOK_SOURCE_GRAPH.map(hookDeclaration),
    ].join("\n")
}
