import {
    accessSync,
    constants,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { delimiter, join, resolve } from "node:path"

/**
 * Stories deliver commits in their worktree only; publishing belongs to the
 * user. The function must stay self-contained: hook-bridge.ts serializes its
 * source into the Claude lane's hook script.
 */
export function publishCommandRefusal(command: string): string | null {
    const segments = String(command)
        .split(/&&|\|\||[;|\n]/u)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
    for (const segment of segments) {
        const tokens = segment
            .split(/\s+/u)
            .map((token) => token.replace(/^['"]|['"]$/gu, ""))
        const refuse = () =>
            `publish commands are denied in story lanes: ${segment}`
        if (tokens.some((token) => token.includes("api.github.com"))) {
            return refuse()
        }
        let i = 0
        while (
            i < tokens.length &&
            (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i]!) ||
                ["env", "command", "exec", "sudo", "nohup", "time"].includes(
                    tokens[i]!,
                ))
        ) {
            i++
        }
        const executable = (tokens[i] ?? "").split("/").pop()
        if (executable === "gh") return refuse()
        if (executable !== "git") continue
        i++
        while (i < tokens.length && tokens[i]!.startsWith("-")) {
            const option = tokens[i]!
            i +=
                ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(
                    option,
                )
                    ? 2
                    : 1
        }
        if (tokens[i] === "push") return refuse()
    }
    return null
}

export const GUARD_REFUSALS_FILE = "refusals.jsonl"

function shQuote(value: string): string {
    return `'${value.replace(/'/gu, `'\\''`)}'`
}

function findExecutable(name: string, pathValue: string, exclude: string): string | null {
    for (const dir of pathValue.split(delimiter)) {
        if (!dir || resolve(dir) === resolve(exclude)) continue
        const candidate = join(dir, name)
        try {
            accessSync(candidate, constants.X_OK)
            return candidate
        } catch {}
    }
    return null
}

/**
 * POSIX `gh` and `git` wrappers for lanes whose CLI has no tool hook: put
 * `dir` first on PATH. `git` forwards everything except push to the real git.
 */
export function materializePublishGuardBin(
    dir: string,
    pathValue: string = process.env.PATH ?? "",
): void {
    mkdirSync(dir, { recursive: true })
    const realGit = findExecutable("git", pathValue, dir) ?? "/usr/bin/git"
    const refusalsPath = shQuote(join(dir, GUARD_REFUSALS_FILE))
    const refuse = [
        `esc=$(printf '%s' "$cmd" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n\\t\\r' '   ')`,
        `printf '{"command":"%s"}\\n' "$esc" >> ${refusalsPath}`,
        `echo "publish commands are denied in story lanes: $cmd" >&2`,
        `exit 1`,
    ].join("\n")
    writeFileSync(
        join(dir, "gh"),
        `#!/bin/sh\ncmd="gh $*"\n${refuse}\n`,
        { mode: 0o755 },
    )
    writeFileSync(
        join(dir, "git"),
        [
            "#!/bin/sh",
            'sub=""',
            "skip=0",
            'for a in "$@"; do',
            '    if [ "$skip" = 1 ]; then skip=0; continue; fi',
            '    case "$a" in',
            "        -C|-c|--git-dir|--work-tree|--namespace) skip=1 ;;",
            "        -*) ;;",
            '        *) sub="$a"; break ;;',
            "    esac",
            "done",
            'if [ "$sub" = push ]; then',
            '    cmd="git $*"',
            ...refuse.split("\n").map((line) => `    ${line}`),
            "fi",
            `exec ${shQuote(realGit)} "$@"`,
            "",
        ].join("\n"),
        { mode: 0o755 },
    )
}

/** Returns and clears the refusals the wrappers recorded since the last call. */
export function drainGuardRefusals(
    dir: string,
): Array<{ command: string; reason: string }> {
    const file = join(dir, GUARD_REFUSALS_FILE)
    let text: string
    try {
        text = readFileSync(file, "utf8")
        rmSync(file, { force: true })
    } catch {
        return []
    }
    const refusals: Array<{ command: string; reason: string }> = []
    for (const line of text.split("\n")) {
        let entry: { command?: unknown; reason?: unknown }
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        const command = String(entry.command ?? "")
        refusals.push({
            command,
            reason:
                typeof entry.reason === "string"
                    ? entry.reason
                    : (publishCommandRefusal(command) ??
                      `publish commands are denied in story lanes: ${command}`),
        })
    }
    return refusals
}
