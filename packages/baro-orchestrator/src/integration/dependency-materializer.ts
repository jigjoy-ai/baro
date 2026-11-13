/**
 * Dependency reuse for the integration worktree: a workspace whose lockfile is
 * byte-identical to the host checkout's, and whose host install is current,
 * gets its own copy of the host's `node_modules` rather than an install.
 *
 * A copy, never a link: whatever runs in the worktree afterwards (a gate, a
 * remedy install, an agent's `npm ci`) cannot reach the host checkout (#284).
 */

import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"

import {
    dependencyInstallEnv,
    pnpmWorkspacePatterns,
    staleDependencyReasons,
    workspacePackageDirs,
    workspacePatterns,
} from "../verification/verify.js"
import { copyDependencyDir } from "./dependency-copy.js"
import { canonicalPath } from "./integration-worktree.js"
import { runRepositoryCommand } from "./repository-command.js"

export interface MaterializeDependenciesOptions {
    hostRoot: string
    integrationRoot: string
    signal?: AbortSignal
    runInstall?: (workspaceDir: string) => Promise<void>
    runBuild?: (workspaceDir: string) => Promise<void>
}

export interface MaterializedWorkspace {
    dir: string
    action: "copied" | "installed" | "built" | "build_failed" | "skipped"
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
    // A host install older than its manifests would be copied with the gap in it.
    const hostCurrent = staleDependencyReasons(hostRoot).length === 0
    let rootMatch = false
    for (const dir of [root, ...workspaceDirs(root)]) {
        const hostDir = join(hostRoot, relative(root, dir))
        const match = lockfileMatch(dir, hostDir)
        if (dir === root) rootMatch = match === true && hostCurrent
        workspaces.push(
            await materializeWorkspace(dir, hostDir, runInstall, {
                // A workspace carrying no lockfile of its own inherits the root's verdict.
                reuseHost: match === null ? rootMatch : match && hostCurrent,
                // A member without a lockfile is installed by its root: npm run
                // inside it resolves that root and reinstalls the whole tree.
                ownsInstall: dir === root || match !== null,
                hostCurrent,
            }),
        )
    }
    const runBuild =
        options.runBuild ?? ((workspaceDir: string) => npmRunBuild(workspaceDir, options.signal))
    workspaces.push(...(await buildConsumedWorkspaces(root, runBuild)))
    return { workspaces }
}

/**
 * A workspace package another one imports resolves through its built entry
 * (`dist/`), which git does not carry: a fresh worktree fails every typecheck
 * on it although the host passes. Built here, dependencies first.
 */
async function buildConsumedWorkspaces(
    root: string,
    runBuild: (workspaceDir: string) => Promise<void>,
): Promise<MaterializedWorkspace[]> {
    const members = [root, ...declaredWorkspaceDirs(root)]
        .map(readMember)
        .filter((member): member is WorkspaceMember => member !== null)
    const byName = new Map(members.filter((m) => m.dir !== root).map((m) => [m.name, m]))
    const consumed = new Set(members.flatMap((m) => m.deps.filter((dep) => byName.has(dep))))
    const results: MaterializedWorkspace[] = []
    const visited = new Set<string>()
    const visit = async (member: WorkspaceMember): Promise<void> => {
        if (visited.has(member.name)) return
        visited.add(member.name)
        for (const dep of member.deps) {
            const target = byName.get(dep)
            if (target) await visit(target)
        }
        if (!consumed.has(member.name) || !member.hasBuild) return
        const missing = member.entries.filter((entry) => !existsSync(join(member.dir, entry)))
        if (missing.length === 0) return
        try {
            await runBuild(member.dir)
            results.push({ dir: member.dir, action: "built", reason: `${missing[0]} is not in the checkout` })
        } catch (error) {
            results.push({ dir: member.dir, action: "build_failed", reason: errMsg(error) })
        }
    }
    for (const member of byName.values()) await visit(member)
    return results
}

interface WorkspaceMember {
    dir: string
    name: string
    deps: string[]
    entries: string[]
    hasBuild: boolean
}

function readMember(dir: string): WorkspaceMember | null {
    let manifest: Record<string, unknown>
    try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>
    } catch {
        return null
    }
    if (typeof manifest.name !== "string") return null
    const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .flatMap((field) => Object.keys(objectField(manifest[field])))
    const entries = new Set<string>()
    for (const field of ["main", "module", "types", "typings"]) {
        const value = manifest[field]
        if (typeof value === "string") entries.add(value)
    }
    collectExportTargets(manifest.exports, entries)
    const scripts = objectField(manifest.scripts)
    return {
        dir,
        name: manifest.name,
        deps,
        entries: [...entries].filter((entry) => !entry.includes("*")),
        hasBuild: typeof scripts.build === "string",
    }
}

function collectExportTargets(value: unknown, into: Set<string>): void {
    if (typeof value === "string") {
        if (value.startsWith("./")) into.add(value)
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) collectExportTargets(item, into)
        return
    }
    for (const item of Object.values(objectField(value))) collectExportTargets(item, into)
}

function objectField(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
}

async function materializeWorkspace(
    dir: string,
    hostDir: string,
    runInstall: (workspaceDir: string) => Promise<void>,
    plan: { reuseHost: boolean; ownsInstall: boolean; hostCurrent: boolean },
): Promise<MaterializedWorkspace> {
    // Not a Node package: `npm ci` here only fails with a usage dump (#210).
    if (!existsSync(join(dir, "package.json"))) {
        return { dir, action: "skipped", reason: "no package.json" }
    }
    const nodeModules = join(dir, "node_modules")
    const hostNodeModules = join(hostDir, "node_modules")
    dropDependencyLink(nodeModules)
    if (existsSync(nodeModules)) return alreadyPresent(dir)
    if (plan.reuseHost && existsSync(hostNodeModules)) {
        const mode = await copyDependencyDir(hostNodeModules, nodeModules)
        return { dir, action: "copied", reason: `lockfile matches host (${mode})` }
    }
    if (!plan.ownsInstall) {
        return { dir, action: "skipped", reason: "installed by its workspace root" }
    }
    return install(
        dir,
        runInstall,
        !existsSync(hostNodeModules)
            ? "host has no node_modules"
            : !plan.hostCurrent
              ? "host install is older than its manifests"
              : "lockfile differs from host",
    )
}

/** A link left by an older baro or an agent: an install would delete through it. */
function dropDependencyLink(nodeModules: string): void {
    try {
        if (lstatSync(nodeModules).isSymbolicLink()) unlinkSync(nodeModules)
    } catch {
        // absent
    }
}

function alreadyPresent(dir: string): MaterializedWorkspace {
    return { dir, action: "skipped", reason: "node_modules already present" }
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
        env: { ...process.env, ...dependencyInstallEnv() },
    })
}

async function npmRunBuild(workspaceDir: string, signal: AbortSignal | undefined): Promise<void> {
    await runRepositoryCommand("npm", ["run", "build"], { cwd: workspaceDir, signal })
}

function declaredWorkspaceDirs(root: string): string[] {
    return workspacePackageDirs(root, [
        ...workspacePatterns(readWorkspacesField(root)),
        ...pnpmWorkspacePatterns(root),
    ])
}

function workspaceDirs(root: string): string[] {
    const declared = declaredWorkspaceDirs(root)
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
