import { accessSync, constants, existsSync, mkdtempSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"

import { gitSandboxPaths } from "../execution/shell-containment.js"

/**
 * OS confinement for a story's CLI agent process (Codex, OpenCode, Pi, Devin)
 * and everything it runs. These CLIs run their tools with approvals and their
 * own sandboxes off, so the guard has to sit around the whole process tree:
 * on macOS a Seatbelt profile that allows writes only to the story worktree,
 * the git metadata a commit needs, a private temp dir and the CLI's own state,
 * and denies reading credential stores. Claude stories use Claude Code's own
 * sandbox instead (hook-bridge.ts).
 *
 * Elsewhere there is no equivalent yet, so the lane does not start unless the
 * user opts out with BARO_UNSAFE_NO_SANDBOX=1.
 */
export type ConfinedSpawn =
    | { binary: string; args: string[]; env: Record<string, string> }
    | { refusal: string }

const CREDENTIAL_READ_DENY = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gh",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".docker/config.json",
    ".kube",
]

/** Where each CLI keeps sessions and auth refreshes, relative to home. */
const LANE_STATE = {
    codex: [".codex"],
    opencode: [".local/share/opencode", ".local/state/opencode", ".cache/opencode", ".config/opencode"],
    pi: [".pi"],
    devin: [".devin", ".config/devin", ".local/share/devin", ".cache/devin"],
} as const satisfies Record<string, readonly string[]>

/** Package-manager caches a build may need to write. */
const SHARED_CACHES = [".npm", ".cache", ".cargo/registry", ".cargo/git", "Library/Caches"]

export function confinedSpawn(
    lane: string,
    binary: string,
    args: readonly string[],
    worktreeRoot: string,
    env: NodeJS.ProcessEnv = process.env,
): ConfinedSpawn {
    const credentialEnv = storyCredentialEnv(env)
    // A CLI that is not installed must still fail as "not installed" (ENOENT,
    // an infrastructure failure), not as sandbox-exec's own exit status.
    if (env.BARO_UNSAFE_NO_SANDBOX === "1" || !resolvesToExecutable(binary, env.PATH)) {
        return { binary, args: [...args], env: credentialEnv }
    }
    if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
        return {
            refusal:
                `the ${lane} lane needs an OS sandbox, and baro has none for it on ${process.platform} yet; ` +
                "use the Claude lane (sandboxed by Claude Code), or set BARO_UNSAFE_NO_SANDBOX=1 to run it unconfined",
        }
    }
    const home = homedir()
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), `baro-${lane}-tmp-`)))
    const writable = [
        realpathSync(resolve(worktreeRoot)),
        ...gitSandboxPaths(worktreeRoot).paths,
        scratch,
        "/dev/null",
        ...[...(LANE_STATE[lane as keyof typeof LANE_STATE] ?? []), ...SHARED_CACHES].map((dir) =>
            join(home, dir),
        ),
    ]
    return {
        binary: "/usr/bin/sandbox-exec",
        args: [
            "-p",
            seatbeltProfile(writable, CREDENTIAL_READ_DENY.map((dir) => join(home, dir))),
            binary,
            ...args,
        ],
        env: { ...credentialEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    }
}

function resolvesToExecutable(binary: string, pathValue: string | undefined): boolean {
    const candidates = binary.includes("/")
        ? [binary]
        : (pathValue ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, binary))
    return candidates.some((candidate) => {
        try {
            accessSync(candidate, constants.X_OK)
            return true
        } catch {
            return false
        }
    })
}

export function seatbeltProfile(writable: readonly string[], unreadable: readonly string[]): string {
    const subpaths = (paths: readonly string[]) =>
        paths.map((entry) => `        (subpath ${JSON.stringify(entry)})`).join("\n")
    return [
        "(version 1)",
        "(allow default)",
        "(deny file-write*",
        "    (require-not",
        "      (require-any",
        subpaths(writable),
        "      )",
        "    )",
        ")",
        ...(unreadable.length > 0
            ? ["(deny file-read*", "    (require-any", subpaths(unreadable), "    )", ")"]
            : []),
    ].join("\n")
}

/**
 * What a story process must not carry: tokens that let it publish, the
 * ssh-agent, and git credential helpers. Every push URL is rewritten to one
 * that cannot work, so even a key it finds elsewhere does not publish.
 */
export function storyCredentialEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue
        if (/^(GH|GITHUB|GH_ENTERPRISE|GITLAB|BITBUCKET)_[A-Z_]*TOKEN$/u.test(key)) continue
        if (key === "SSH_AUTH_SOCK" || key === "GIT_ASKPASS" || key === "SSH_ASKPASS") continue
        out[key] = value
    }
    const settings: Array<[string, string]> = [
        ["credential.helper", ""],
        ["url.baro-push-disabled://.pushInsteadOf", "https://"],
        ["url.baro-push-disabled://.pushInsteadOf", "ssh://"],
        ["url.baro-push-disabled://.pushInsteadOf", "git@"],
        ["url.baro-push-disabled://.pushInsteadOf", "git://"],
    ]
    const offset = Number.parseInt(out.GIT_CONFIG_COUNT ?? "0", 10) || 0
    settings.forEach(([key, value], index) => {
        out[`GIT_CONFIG_KEY_${offset + index}`] = key
        out[`GIT_CONFIG_VALUE_${offset + index}`] = value
    })
    out.GIT_CONFIG_COUNT = String(offset + settings.length)
    out.GIT_TERMINAL_PROMPT = "0"
    return out
}
