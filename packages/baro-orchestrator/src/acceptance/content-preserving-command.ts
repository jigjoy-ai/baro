// Shell commands that cannot change the story's changed-content fingerprint
// (working tree vs the fixed story base). Agents run `git add && git commit`
// or a quick `git status` right after their tests; treating those as workspace
// activity discarded the test evidence and cost a whole revision turn. Anything
// not provably read-only here stays activity, so an unknown command is never
// trusted.

export interface ContentPreservingCommand {
    preserving: boolean
    /** git commit runs hooks, which may rewrite files; callers check for hooks. */
    commits: boolean
}

const NOT_PRESERVING: ContentPreservingCommand = { preserving: false, commits: false }

const READ_ONLY = new Set([
    "cd", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg",
    "echo", "printf", "true", "test", "[", "stat", "which", "type", "diff", "cmp",
    "cut", "tr", "basename", "dirname", "realpath", "printenv", "sleep", "jq",
])

const GIT_READ_ONLY = new Set([
    "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file",
    "blame", "grep", "describe", "shortlog", "merge-base", "rev-list", "name-rev",
])

// `git add` only stages: the working tree, which the fingerprint hashes, is untouched.
const GIT_INDEX_ONLY = new Set(["add"])

const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/u
const HARMLESS_REDIRECT = /\s*(?:\d?>\s*\/dev\/null|\d>&\d)/gu
// The message form agents use for commits: "$(cat <<'EOF' ... EOF)" only reads a heredoc.
const HEREDOC_MESSAGE = /"\$\(cat <<-?\s*(['"])(\w+)\1\n[\s\S]*?\n\s*\2\s*\)"/gu
const SINGLE_QUOTED = /'[^']*'/gu
const DOUBLE_QUOTED = /"(?:[^"\\$`]|\\.)*"/gu
const UNSAFE = /[<>`$"']|\b(?:xargs|tee)\b/u
// Options that write a file or run a program even on otherwise read-only tools.
const UNSAFE_OPTION = /^(?:--output|--pre\b|-O$|--open-files-in-pager|--ext-diff)/u

export function contentPreservingCommand(command: string): ContentPreservingCommand {
    let script = command.trim()
    const wrapped = SHELL_WRAPPER.exec(script)
    if (wrapped) script = wrapped[2]!.trim()
    // Quoted text is an argument, never a command, unless it expands ($ or backtick),
    // which DOUBLE_QUOTED leaves in place for UNSAFE to refuse.
    script = script
        .replace(HEREDOC_MESSAGE, "MSG")
        .replace(SINGLE_QUOTED, "Q")
        .replace(DOUBLE_QUOTED, "Q")
        .replace(HARMLESS_REDIRECT, "")
    if (script === "" || UNSAFE.test(script)) return NOT_PRESERVING

    let commits = false
    for (const segment of script.split(/&&|\|\||[;|\n]/u)) {
        const words = segment.trim().split(/\s+/u).filter(Boolean)
        if (words.length === 0) continue
        const [program, ...rest] = words
        if (rest.some((w) => UNSAFE_OPTION.test(w))) return NOT_PRESERVING
        if (program === "git") {
            const sub = gitSubcommand(rest)
            if (sub === null) return NOT_PRESERVING
            if (sub === "commit") {
                // commit never writes the working tree except through hooks.
                commits = true
                continue
            }
            if (GIT_READ_ONLY.has(sub) || GIT_INDEX_ONLY.has(sub)) continue
            return NOT_PRESERVING
        }
        if (program === "sed") {
            if (rest.some((w) => /^-[a-zA-Z]*i/u.test(w) || w.startsWith("--in-place"))) return NOT_PRESERVING
            if (!rest.includes("-n")) return NOT_PRESERVING
            continue
        }
        if (program === "find") {
            if (rest.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/u.test(w))) return NOT_PRESERVING
            continue
        }
        if (!READ_ONLY.has(program!)) return NOT_PRESERVING
    }
    return { preserving: true, commits }
}

/** The git subcommand after global options, or null when they cannot be read safely. */
function gitSubcommand(words: readonly string[]): string | null {
    let i = 0
    while (i < words.length && words[i]!.startsWith("-")) {
        const option = words[i]!
        // -c could point a hook or fsmonitor at any program, so only -C is read.
        if (option === "-C") i += 2
        else if (option === "--no-pager") i += 1
        else return null
    }
    return words[i] ?? null
}
