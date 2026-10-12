import { spawnSync } from "node:child_process"

const majors = new Map<string, number>()

/**
 * Major version of an `opencode` binary, read once per path. OpenCode 2.0
 * dropped `--dir`, `--dangerously-skip-permissions` and `--pure`; given them,
 * `opencode run` prints its help and exits without running anything.
 * Anything unreadable counts as 1, the flags baro has always sent.
 */
export function openCodeMajor(bin: string): number {
    // Set by tests whose stand-in binaries cannot answer --version.
    const pinned = Number.parseInt(process.env.BARO_OPENCODE_MAJOR ?? "", 10)
    if (Number.isInteger(pinned)) return pinned
    const cached = majors.get(bin)
    if (cached !== undefined) return cached
    let major = 1
    try {
        const result = spawnSync(bin, ["--version"], {
            encoding: "utf8",
            timeout: 15_000,
            shell: process.platform === "win32",
        })
        const found = `${result.stdout ?? ""} ${result.stderr ?? ""}`.match(/(?:^|[^\d.])(\d+)\.\d+\.\d+/)
        if (found) major = Number.parseInt(found[1]!, 10)
    } catch {
        // A binary that cannot report its version keeps the 1.x flags.
    }
    majors.set(bin, major)
    return major
}

export interface OpenCodeRunFlags {
    readonly cwd?: string
    readonly model?: string
    /** Approve tool calls without asking: story and planner runs. */
    readonly autoApprove?: boolean
    /** Locked-down evaluator agent installed through OPENCODE_CONFIG. */
    readonly evaluatorAgent?: string
}

/** `opencode run` arguments for the installed major version. */
export function openCodeRunArgs(bin: string, flags: OpenCodeRunFlags): string[] {
    const args = ["run", "--format", "json"]
    if (openCodeMajor(bin) >= 2) {
        // A private server per run: the shared background service would read
        // neither this run's OPENCODE_CONFIG nor its working directory, and
        // its processes would outlive the story's process tree.
        args.push("--standalone")
        if (flags.evaluatorAgent) args.push("--agent", flags.evaluatorAgent)
        else if (flags.autoApprove) args.push("--auto")
        if (flags.model) args.push("-m", flags.model)
        return args
    }
    if (flags.evaluatorAgent) args.push("--pure", "--agent", flags.evaluatorAgent)
    else if (flags.autoApprove) args.push("--dangerously-skip-permissions")
    if (flags.model) args.push("-m", flags.model)
    if (flags.cwd) args.push("--dir", flags.cwd)
    return args
}

/** Tests swap binaries under one path. */
export function __resetOpenCodeMajorCache(): void {
    majors.clear()
}
