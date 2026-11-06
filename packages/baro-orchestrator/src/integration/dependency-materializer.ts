/**
 * Dependency reuse for the integration worktree: a workspace whose lockfile is
 * byte-identical to the host checkout's gets the host's `node_modules`
 * symlinked in rather than installed.
 *
 * The link writes straight into the host's `node_modules` (`.bin`, caches)
 * whenever the gate runs in the worktree, and nothing here prunes or copies.
 * Teardown must therefore stay `git worktree remove`; an `rm -rf` would
 * follow the link into the host checkout.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, symlinkSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"

import {
    pnpmWorkspacePatterns,
    workspacePackageDirs,
    workspacePatterns,
} from "../verification/verify.js"
import { canonicalPath } from "./integration-worktree.js"
import { runRepositoryCommand } from "./repository-command.js"

export interface MaterializeDependenciesOptions {
    hostRoot: string
    integrationRoot: string
    signal?: AbortSignal
    runInstall?: (workspaceDir: string) => Promise<void>
}

export interface MaterializedWorkspace {
    dir: string
    action: "linked" | "installed" | "skipped"
    reason: string
}

export interface MaterializeDependenciesResult {
    workspaces: MaterializedWorkspace[]
}

const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json"] as const

/** Single owner of this path: an install failure has to name the cache it used. */
export function npmCachePath(env: NodeJS.ProcessEnv = process.env): string {
    return env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? join(homedir(), ".npm")
}

export async function materializeDependencies(
    options: MaterializeDependenciesOptions,
): Promise<MaterializeDependenciesResult> {
    const { hostRoot, integrationRoot } = options
    if (canonicalPath(hostRoot) === canonicalPath(integrationRoot)) {
        return {
            workspaces: [
                {
                    dir: integrationRoot,
                    action: "skipped",
                    reason: "host and worktree are the same directory",
                },
            ],
        }
    }
    const runInstall =
        options.runInstall ?? ((workspaceDir: string) => npmCi(workspaceDir, options.signal))
    const root = resolve(integrationRoot)
    const workspaces: MaterializedWorkspace[] = []
    let rootMatch = false
    for (const dir of [root, ...workspaceDirs(root)]) {
        const hostDir = join(hostRoot, relative(root, dir))
        const match = lockfileMatch(dir, hostDir)
        if (dir === root) rootMatch = match === true
        // A workspace carrying no lockfile of its own inherits the root's verdict.
        workspaces.push(await materializeWorkspace(dir, hostDir, match ?? rootMatch, runInstall))
    }
    return { workspaces }
}

async function materializeWorkspace(
    dir: string,
    hostDir: string,
    match: boolean,
    runInstall: (workspaceDir: string) => Promise<void>,
): Promise<MaterializedWorkspace> {
    // Not a Node package: `npm ci` here only fails with a usage dump (#210).
    if (!existsSync(join(dir, "package.json"))) {
        return { dir, action: "skipped", reason: "no package.json" }
    }
    const nodeModules = join(dir, "node_modules")
    const hostNodeModules = join(hostDir, "node_modules")
    if (match && existsSync(hostNodeModules) && !existsSync(nodeModules)) {
        const linked = linkNodeModules(hostNodeModules, nodeModules)
        if (linked === "linked") return { dir, action: "linked", reason: "lockfile matches host" }
        if (linked === "exists") return alreadyPresent(dir)
        return install(dir, runInstall, "symlink unsupported")
    }
    if (existsSync(nodeModules)) return alreadyPresent(dir)
    return install(dir, runInstall, match ? "host has no node_modules" : "lockfile differs from host")
}

function alreadyPresent(dir: string): MaterializedWorkspace {
    return { dir, action: "skipped", reason: "node_modules already present" }
}

function linkNodeModules(
    hostNodeModules: string,
    nodeModules: string,
): "linked" | "exists" | "unsupported" {
    try {
        symlinkSync(
            hostNodeModules,
            nodeModules,
            process.platform === "win32" ? "junction" : "dir",
        )
        return "linked"
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EEXIST") return "exists"
        // Windows without symlink rights: install rather than fail the run.
        if (code === "EPERM" || code === "ENOSYS") return "unsupported"
        throw error
    }
}

async function install(
    dir: string,
    runInstall: (workspaceDir: string) => Promise<void>,
    reason: string,
): Promise<MaterializedWorkspace> {
    try {
        await runInstall(dir)
    } catch (error) {
        throw new Error(
            `npm ci --prefer-offline failed in ${dir} (npm cache: ${npmCachePath()}): ${errMsg(error)}`,
            { cause: error },
        )
    }
    return { dir, action: "installed", reason }
}

async function npmCi(workspaceDir: string, signal: AbortSignal | undefined): Promise<void> {
    await runRepositoryCommand("npm", ["ci", "--prefer-offline"], {
        cwd: workspaceDir,
        signal,
    })
}

function workspaceDirs(root: string): string[] {
    const declared = workspacePackageDirs(root, [
        ...workspacePatterns(readWorkspacesField(root)),
        ...pnpmWorkspacePatterns(root),
    ])
    const seen = new Set([resolve(root), ...declared.map((dir) => resolve(dir))])
    // An independent package in a subdirectory (`js/` with its own lockfile)
    // is no workspace, yet its tests import what its lockfile pins; smoke
    // run 5 failed its final gate on exactly that.
    const nested = nestedLockedPackages(root).filter((dir) => !seen.has(resolve(dir)))
    return [...declared, ...nested]
}

const NESTED_SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next", "out", "coverage"])

function nestedLockedPackages(root: string, depth = 3): string[] {
    const found: string[] = []
    const scan = (dir: string, left: number): void => {
        if (left <= 0) return
        let entries: Dirent[]
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || NESTED_SCAN_SKIP.has(entry.name) || entry.name.startsWith(".")) continue
            const child = join(dir, entry.name)
            if (
                existsSync(join(child, "package.json")) &&
                LOCKFILE_NAMES.some((name) => existsSync(join(child, name)))
            ) {
                found.push(child)
            }
            scan(child, left - 1)
        }
    }
    scan(root, depth)
    return found
}

function readWorkspacesField(dir: string): unknown {
    try {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
            workspaces?: unknown
        }
        return manifest.workspaces
    } catch {
        return undefined
    }
}

function lockfileMatch(dir: string, hostDir: string): boolean | null {
    const name = LOCKFILE_NAMES.find((candidate) => existsSync(join(dir, candidate)))
    if (!name) return null
    const local = sha256(join(dir, name))
    return local !== null && local === sha256(join(hostDir, name))
}

function sha256(path: string): string | null {
    try {
        return createHash("sha256").update(readFileSync(path)).digest("hex")
    } catch {
        return null
    }
}

function errMsg(error: unknown): string {
    return (error as Error)?.message ?? String(error)
}

/**
 * Right before a final gate: packages the stories added (a js/ with its own
 * lockfile) did not exist when the integration worktree was first
 * materialized. Never throws; the gate reports whatever is still missing.
 */
export async function materializeBeforeGate(
    hostRoot: string | undefined,
    integrationRoot: string,
    log: (line: string) => void,
): Promise<void> {
    if (!hostRoot) return
    try {
        const { workspaces } = await materializeDependencies({ hostRoot, integrationRoot })
        for (const workspace of workspaces) {
            if (workspace.action !== "skipped") {
                log(`dependencies ${workspace.action} in ${workspace.dir} (${workspace.reason})`)
            }
        }
    } catch (error) {
        log(`could not install dependencies before the final gate: ${errMsg(error)}`)
    }
}
