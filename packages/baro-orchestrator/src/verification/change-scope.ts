/**
 * Which detected build/test commands a change can affect: a Rust-only run
 * once spent 20 minutes on the untouched TypeScript suite. Fails open — an
 * unclassifiable changed file or an unreadable diff runs everything; declared
 * tests always run. BARO_VERIFY_SCOPE=0 disables scoping.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, extname, join, relative, resolve } from "node:path"

import type { VerifyCommandSpec } from "./verify.js"

export type VerifyEcosystem = "javascript" | "rust" | "go" | "jvm"

const JAVASCRIPT_TOOLS = new Set(["npm", "pnpm", "yarn", "corepack", "node", "npx", "bun"])
const JAVASCRIPT_EXTENSIONS = new Set([
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
    ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less",
])
const JAVASCRIPT_ROOT_FILES = new Set([
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "yarn.lock", ".yarnrc", ".yarnrc.yml", ".npmrc", ".nvmrc",
    ".node-version", "bun.lockb", "bun.lock",
])
const RUST_FILES = new Set([
    "Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain", "rust-toolchain.toml",
    "rustfmt.toml", ".rustfmt.toml", "clippy.toml", ".clippy.toml",
])
const GO_FILES = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"])
const JVM_EXTENSIONS = new Set([".java", ".kt", ".kts", ".groovy", ".scala"])
const JVM_FILES = new Set([
    "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    "gradle.properties", "mvnw", "mvnw.cmd", "gradlew", "gradlew.bat",
])
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"])
const DOC_FILES = /^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS|CHANGELOG|CODEOWNERS)(\..*)?$/iu
const DOC_DIRS = ["docs/", ".github/"]
const NEUTRAL_FILES = new Set([".gitignore", ".gitattributes", ".editorconfig", ".mailmap"])

/** The ecosystem a detected command checks, or null when it is not one of ours to scope. */
export function commandEcosystem(command: VerifyCommandSpec): VerifyEcosystem | null {
    if (command.origin === "declared" || command.preflightFailure || command.incompleteReason) {
        return null
    }
    if (command.tool === "cargo") return "rust"
    if (command.tool === "go") return "go"
    if (/^(mvn|gradle) /u.test(command.label)) return "jvm"
    if (JAVASCRIPT_TOOLS.has(command.tool)) return "javascript"
    return null
}

/** "all" when some changed path belongs to no ecosystem and is not documentation. */
export function affectedEcosystems(
    paths: readonly string[],
    root: string,
    javascriptDirs: readonly string[] = javascriptPackageDirs(root),
): Set<VerifyEcosystem> | "all" {
    const affected = new Set<VerifyEcosystem>()
    const workspaces = javascriptDirs
        .map((dir) => relative(resolve(root), resolve(dir)).replace(/\\/gu, "/"))
        .filter((dir) => dir !== "" && !dir.startsWith(".."))
        .map((dir) => `${dir}/`)
    for (const raw of paths) {
        const path = raw.replace(/\\/gu, "/").replace(/^\.\//u, "")
        if (!path) continue
        const claims = claimsOf(path, root, workspaces)
        if (claims.length > 0) {
            for (const claim of claims) affected.add(claim)
            continue
        }
        if (isNeutral(path)) continue
        return "all"
    }
    return affected
}

function claimsOf(path: string, root: string, workspaces: readonly string[]): VerifyEcosystem[] {
    const name = basename(path)
    const ext = extname(name).toLowerCase()
    const claims: VerifyEcosystem[] = []
    if (
        ext === ".rs" ||
        RUST_FILES.has(name) ||
        path.startsWith(".cargo/") ||
        insidePackageDir(path, root, ["Cargo.toml"])
    ) {
        claims.push("rust")
    }
    if (ext === ".go" || GO_FILES.has(name) || insidePackageDir(path, root, ["go.mod"])) {
        claims.push("go")
    }
    if (
        JVM_EXTENSIONS.has(ext) ||
        JVM_FILES.has(name) ||
        path.startsWith("gradle/") ||
        insidePackageDir(path, root, ["pom.xml", "build.gradle", "build.gradle.kts"])
    ) {
        claims.push("jvm")
    }
    if (
        JAVASCRIPT_EXTENSIONS.has(ext) ||
        (JAVASCRIPT_ROOT_FILES.has(name) && !path.includes("/")) ||
        /^tsconfig.*\.json$/u.test(name) ||
        workspaces.some((dir) => path.startsWith(dir))
    ) {
        claims.push("javascript")
    }
    return claims
}

/** Any file in a sub-package dir counts: its build may read it (include_str!, testdata). */
function insidePackageDir(path: string, root: string, manifests: readonly string[]): boolean {
    let dir = dirname(path)
    while (dir && dir !== "." && dir !== "/") {
        if (manifests.some((manifest) => existsSync(join(root, dir, manifest)))) return true
        dir = dirname(dir)
    }
    return false
}

function isNeutral(path: string): boolean {
    const name = basename(path)
    return (
        DOC_EXTENSIONS.has(extname(name).toLowerCase()) ||
        DOC_FILES.test(name) ||
        NEUTRAL_FILES.has(name) ||
        DOC_DIRS.some((dir) => path.startsWith(dir))
    )
}

function javascriptPackageDirs(root: string): string[] {
    try {
        const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            workspaces?: unknown
        }
        const patterns = Array.isArray(manifest.workspaces)
            ? manifest.workspaces
            : (manifest.workspaces as { packages?: unknown } | undefined)?.packages
        if (!Array.isArray(patterns)) return []
        // Only the pattern prefix matters: it claims non-JS files inside workspaces.
        return patterns
            .filter((pattern): pattern is string => typeof pattern === "string")
            .map((pattern) => pattern.replace(/\/?\*.*$/u, ""))
            .filter(Boolean)
            .map((dir) => join(root, dir))
    } catch {
        return []
    }
}

/** Committed, uncommitted and untracked changes since `base`; null when git cannot say. */
export function changedPathsSince(cwd: string, base: string): string[] | null {
    const git = (args: string[]): string =>
        execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 15_000,
            maxBuffer: 16 * 1024 * 1024,
        })
    try {
        const paths = new Set<string>()
        for (const line of git(["diff", "--name-only", "-z", base]).split("\0")) {
            if (line) paths.add(line)
        }
        for (const line of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
            if (line) paths.add(line)
        }
        return [...paths]
    } catch {
        return null
    }
}

export interface ScopedCommands {
    readonly run: readonly VerifyCommandSpec[]
    readonly notAffected: readonly VerifyCommandSpec[]
}

/** Splits a plan's commands into those the change can affect and those it cannot. */
export function scopeCommandsToChange(
    commands: readonly VerifyCommandSpec[],
    paths: readonly string[] | null,
    root: string,
    env: NodeJS.ProcessEnv = process.env,
): ScopedCommands {
    if (env.BARO_VERIFY_SCOPE === "0" || paths === null || paths.length === 0) {
        return { run: commands, notAffected: [] }
    }
    const affected = affectedEcosystems(paths, root)
    if (affected === "all") return { run: commands, notAffected: [] }
    const run: VerifyCommandSpec[] = []
    const notAffected: VerifyCommandSpec[] = []
    for (const command of commands) {
        const ecosystem = commandEcosystem(command)
        if (ecosystem === null || affected.has(ecosystem)) run.push(command)
        else notAffected.push(command)
    }
    // Narrow only to a gate that still checks something: a docs-only change
    // that ran no suite would read as an unverified run.
    if (!run.some((command) => commandEcosystem(command) !== null)) {
        return { run: commands, notAffected: [] }
    }
    return { run, notAffected }
}
