/**
 * The integration worktree lives under tmpdir(), so cargo there would build a
 * fresh target/ every run. Point it at the host checkout's target/ instead.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, delimiter, join, resolve } from "node:path"

import { baroHome } from "../runtime/baro-home.js"

/** Stable per-checkout directory name; the hash keeps two same-named checkouts apart. */
export function repositoryCacheKey(hostRoot: string): string {
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
    const cached = join(baroHome(), "cargo-target", repositoryCacheKey(hostRoot))
    mkdirSync(cached, { recursive: true })
    return cached
}

/** Sole owner of the cargo env shape; execFileCli replaces rather than merges. */
export function cargoEnvFor(
    hostRoot: string,
    env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    const base = env ?? process.env
    const toolchain = cargoOnPath(base) ? null : rustToolchainBin(base)
    return {
        ...base,
        ...(toolchain ? { PATH: [toolchain, base.PATH].filter(Boolean).join(delimiter) } : {}),
        CARGO_TARGET_DIR: resolveCargoTargetDir(hostRoot, env),
    }
}

function cargoOnPath(env: NodeJS.ProcessEnv): boolean {
    const names = process.platform === "win32" ? ["cargo.exe", "cargo.cmd"] : ["cargo"]
    return (env.PATH ?? "").split(delimiter).some((dir) => dir && names.some((name) => existsSync(join(dir, name))))
}

/**
 * rustup installs cargo where only a login shell's profile puts it on PATH;
 * a gate spawned from anything else reported a real install as missing.
 */
export function rustToolchainBin(env: NodeJS.ProcessEnv): string | null {
    const home = env.HOME ?? env.USERPROFILE
    if (!home) return null
    const exe = process.platform === "win32" ? "cargo.exe" : "cargo"
    const cargoHome = join(env.CARGO_HOME || join(home, ".cargo"), "bin")
    if (existsSync(join(cargoHome, exe))) return cargoHome
    const rustupHome = env.RUSTUP_HOME || join(home, ".rustup")
    let toolchain: string | undefined
    try {
        toolchain = /^default_toolchain\s*=\s*"([^"]+)"/mu.exec(readFileSync(join(rustupHome, "settings.toml"), "utf8"))?.[1]
    } catch {
        return null
    }
    if (!toolchain || toolchain.includes("/") || toolchain.includes("..")) return null
    const bin = join(rustupHome, "toolchains", toolchain, "bin")
    return existsSync(join(bin, exe)) ? bin : null
}
