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
 * user, and the repository's shared state (config, refs other than the story's
 * own commits, reflogs, other worktrees, remotes) is not a story's to change:
 * a story could otherwise plant a hook the orchestrator runs as the user,
 * delete the recovery branch of a failed attempt, or expire the reflog that
 * would bring it back. Returns the refusal, or null.
 *
 * Self-contained on purpose: hook-bridge.ts and the git wrapper of the CLI
 * lanes serialize this function's source.
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
        const publish = () =>
            `publish commands are denied in story lanes: ${segment}`
        const shared = () =>
            `commands that change the repository's shared state are denied in story lanes: ${segment} (for a commit identity, pass it per command: git -c user.name=... -c user.email=... commit)`
        if (tokens.some((token) => token.toLowerCase().includes("api.github.com"))) {
            return publish()
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
        if (executable === "gh") return publish()
        if (executable !== "git") continue
        i++
        while (i < tokens.length && tokens[i]!.startsWith("-")) {
            const option = tokens[i]!
            // An alias expands inside git, past any check on the command line.
            if (option === "--config-env" || option.startsWith("--config-env=")) return shared()
            if (option === "-c" && /^alias\./iu.test(tokens[i + 1] ?? "")) return shared()
            i +=
                ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(
                    option,
                )
                    ? 2
                    : 1
        }
        const sub = tokens[i] ?? ""
        const rest = tokens.slice(i + 1)
        const has = (...flags: string[]) =>
            rest.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
        if (["push", "send-pack"].includes(sub)) return publish()
        if (["update-ref", "gc", "prune", "worktree", "filter-branch", "filter-repo", "replace"].includes(sub)) {
            return shared()
        }
        if (sub === "config") {
            const reads = ["--get", "--get-all", "--get-regexp", "--list", "-l", "--get-urlmatch", "--show-origin", "--show-scope"]
            if (!rest.some((arg) => reads.includes(arg) || arg === "get" || arg === "list")) return shared()
        }
        if (sub === "remote") {
            const readOnly = rest.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(rest[0]!)
            if (!readOnly) return shared()
        }
        if (sub === "reflog" && rest.length > 0 && !["show", "list", "exists"].includes(rest[0]!)) {
            return shared()
        }
        if (sub === "symbolic-ref" && rest.filter((arg) => !arg.startsWith("-")).length >= 2) {
            return shared()
        }
        if (sub === "branch" && has("-d", "-D", "--delete", "-f", "--force", "-m", "-M", "--move", "-c", "-C", "--copy", "--set-upstream-to", "-u")) {
            return shared()
        }
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
    // The same policy the Claude hook and the native lane apply, not a
    // narrower shell re-implementation of it.
    writeFileSync(
        join(dir, "git"),
        [
            "#!/usr/bin/env node",
            "const { spawnSync } = require(\"node:child_process\")",
            "const { appendFileSync } = require(\"node:fs\")",
            "const __name = (fn) => fn",
            `const publishCommandRefusal = ${publishCommandRefusal.toString()}`,
            "const args = process.argv.slice(2)",
            "const command = [\"git\", ...args].join(\" \")",
            "const refusal = publishCommandRefusal(command)",
            "if (refusal) {",
            `    try { appendFileSync(${JSON.stringify(join(dir, GUARD_REFUSALS_FILE))}, JSON.stringify({ command, reason: refusal }) + "\\n") } catch {}`,
            "    process.stderr.write(refusal + \"\\n\")",
            "    process.exit(1)",
            "}",
            `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" })`,
            "process.exit(result.status === null ? 1 : result.status)",
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
