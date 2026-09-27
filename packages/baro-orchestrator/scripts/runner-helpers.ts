// Helpers for the `baro connect` runner, split out so they can be unit
// tested without executing runner.ts's main() (it connects on import).

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function semverLt(a: string, b: string): boolean {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < 3; i++) {
        const x = pa[i] ?? 0
        const y = pb[i] ?? 0
        if (x !== y) return x < y
    }
    return false
}

export interface ReexecCommand {
    cmd: string
    args: string[]
    env: NodeJS.ProcessEnv
}

// After a foreground self-update, restart in place: same node, same script +
// args, same credentials/runnerId. BARO_UPDATED=1 makes the child skip the
// update check so a bad publish can't cause an update→re-exec loop.
export function buildReexec(execPath: string, argv: readonly string[], env: NodeJS.ProcessEnv): ReexecCommand {
    return { cmd: execPath, args: argv.slice(1), env: { ...env, BARO_UPDATED: "1" } }
}

export function buildInstallServiceArgs(opts: { token: string; workspace: string; controlUrl?: string }): string[] {
    const args = ["connect", "--install-service", "--token", opts.token, "--workspace", opts.workspace]
    if (opts.controlUrl) args.push("--control-url", opts.controlUrl)
    return args
}

/** Match Rust's backwards-compatible Done.success default without truthy coercion. */
export function parseDoneSuccess(value: unknown): boolean | null {
    if (typeof value === "boolean") return value
    if (value === undefined) return true
    return null
}

// Reads the token from a file on each call, so a token refreshed mid-run reaches
// every later push from the clone and its worktrees (they share its config).
export function gitCredentialHelper(tokenFile: string): string {
    if (tokenFile.includes("'")) throw new Error(`unsupported token path: ${tokenFile}`)
    return `!f() { if [ "$1" = get ]; then printf 'username=x-access-token\\npassword=%s\\n' "$(cat '${tokenFile}')"; fi; }; f`
}

// gh re-reads GH_CONFIG_DIR on every call, while a GH_TOKEN env var would pin the
// child to the first token. config.yml's version skips gh's multi-account migration.
export function writeGithubCredentials(dir: string, token: string): void {
    mkdirSync(join(dir, "gh"), { recursive: true, mode: 0o700 })
    const write = (path: string, body: string) => {
        writeFileSync(`${path}.tmp`, body, { mode: 0o600 })
        renameSync(`${path}.tmp`, path)
    }
    write(join(dir, "gh", "config.yml"), 'version: "1"\n')
    write(
        join(dir, "gh", "hosts.yml"),
        `github.com:\n    users:\n        x-access-token:\n            oauth_token: ${token}\n    oauth_token: ${token}\n    user: x-access-token\n    git_protocol: https\n`,
    )
    write(join(dir, "token"), `${token}\n`)
}

const MAX_RECOVERY_DIFF_CHARS = 200_000

// The run's goal branch (from prd.json) against where the run started: the work a
// failed push left only in this clone, which is deleted when the run ends.
export function unpublishedWorkDiff(cwd: string, base: string): string | undefined {
    try {
        const named = (JSON.parse(readFileSync(join(cwd, "prd.json"), "utf8")) as { branchName?: unknown }).branchName
        if (typeof named !== "string" || !named) return undefined
        let branch = named
        while (branch.startsWith("baro/baro/")) branch = branch.slice("baro/".length)
        const head = execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd }).toString().trim()
        const out = execFileSync("git", ["diff", "--binary", base, head], { cwd, maxBuffer: 16 * 1024 * 1024 }).toString()
        if (!out.trim()) return undefined
        return out.length > MAX_RECOVERY_DIFF_CHARS ? out.slice(0, MAX_RECOVERY_DIFF_CHARS) + "\n… (diff truncated)" : out
    } catch {
        return undefined
    }
}
