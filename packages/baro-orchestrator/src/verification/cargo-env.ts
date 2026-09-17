/**
 * The integration worktree lives under tmpdir(), so cargo there would build a
 * fresh target/ every run. Point it at the host checkout's target/ instead.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

/** Stable per-checkout directory name; the hash keeps two same-named checkouts apart. */
function repositoryCacheKey(hostRoot: string): string {
    let canonical: string
    try {
        canonical = realpathSync.native(hostRoot)
    } catch {
        canonical = resolve(hostRoot)
    }
    const name = basename(canonical).replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 40)
    return `${name}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`
}

export function resolveCargoTargetDir(
    hostRoot: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const declared = env.CARGO_TARGET_DIR
    if (typeof declared === "string" && declared.length > 0) return declared
    const hostTarget = join(hostRoot, "target")
    if (existsSync(hostTarget)) return hostTarget
    const cached = join(homedir(), ".baro", "cargo-target", repositoryCacheKey(hostRoot))
    mkdirSync(cached, { recursive: true })
    return cached
}

/** Sole owner of the cargo env shape; execFileCli replaces rather than merges. */
export function cargoEnvFor(
    hostRoot: string,
    env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return { ...(env ?? process.env), CARGO_TARGET_DIR: resolveCargoTargetDir(hostRoot, env) }
}
