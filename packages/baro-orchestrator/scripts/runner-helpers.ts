// Pure helpers for the `baro connect` runner, split out so they can be unit
// tested without executing runner.ts's main() (it connects on import).

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
