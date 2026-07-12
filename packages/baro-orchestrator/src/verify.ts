/**
 * Objective build/test/typecheck/lint VERIFY gate for the fully-merged branch.
 *
 * baro's Critic is an LLM that JUDGES pass/fail against acceptance criteria —
 * it never runs the tests. A per-story gate is unsafe in a shared worktree
 * (sibling stories' incomplete work fails the build through no fault of this
 * story). The one correct place to actually run the build + tests is here, at
 * the end, on the fully-merged branch where everything is present.
 *
 * Semantics that must NOT false-fail:
 *   - ran=false  when nothing could be verified (no manifest, no build/test
 *                script, or the tool is missing/ENOENT). "Couldn't verify" is
 *                not "failed" — it must not force a checkpoint.
 *   - ok=false   only when a build/test that ACTUALLY RAN returned non-zero.
 */

import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const TIMEOUT_MS = 5 * 60_000
const TAIL_BYTES = 1500

export interface VerifyResult {
    ran: boolean
    ok: boolean
    failures: Array<{ cmd: string; tail: string }>
    commands: VerifyCommandResult[]
}

export interface VerifyCommandResult {
    command: string
    status: "passed" | "failed" | "skipped"
    durationMs: number
    tail?: string
}

export interface VerifyCommandSpec {
    /** Human-readable form for logs + PR body, e.g. "npm run build". */
    label: string
    tool: string
    args: readonly string[]
    /** A workspace package can own the script even when the root does not. */
    cwd?: string
    /** A deterministic discovery/configuration failure, executed as evidence. */
    preflightFailure?: string
}

export interface VerifyPlan {
    readonly commands: readonly VerifyCommandSpec[]
}

export interface VerifyBuildOptions {
    /** Cancels the current child and prevents later commands from starting. */
    signal?: AbortSignal
    /** Snapshotted before agents mutate the target repo. */
    plan?: VerifyPlan
}

interface PackageManifest {
    scripts?: Record<string, unknown>
    workspaces?: unknown
}

function readPackageManifest(path: string): PackageManifest | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as PackageManifest
    } catch {
        return null
    }
}

function workspacePatterns(workspaces: unknown): string[] {
    if (Array.isArray(workspaces)) {
        return workspaces.filter((value): value is string => typeof value === "string")
    }
    if (
        workspaces &&
        typeof workspaces === "object" &&
        "packages" in workspaces &&
        Array.isArray((workspaces as { packages?: unknown }).packages)
    ) {
        return (workspaces as { packages: unknown[] }).packages.filter(
            (value): value is string => typeof value === "string",
        )
    }
    return []
}

function pnpmWorkspacePatterns(cwd: string): string[] {
    const path = join(cwd, "pnpm-workspace.yaml")
    if (!existsSync(path)) return []
    const patterns: string[] = []
    let inPackages = false
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (/^packages\s*:\s*(?:#.*)?$/.test(line)) {
            inPackages = true
            continue
        }
        if (!inPackages) continue
        if (/^\S/.test(line)) break
        const match = line.match(/^\s*-\s*(.+?)\s*(?:#.*)?$/)
        if (!match) continue
        const value = match[1]!.trim().replace(/^(['"])(.*)\1$/, "$2")
        if (value) patterns.push(value)
    }
    return patterns
}

/**
 * Expand the common workspace forms used by npm, pnpm and Yarn without adding
 * a glob dependency. Nested/complex patterns are deliberately ignored instead
 * of guessing which directories are executable packages.
 */
function workspacePackageDirs(cwd: string, workspaces: unknown): string[] {
    const root = resolve(cwd)
    const dirs = new Set<string>()
    const addIfPackage = (candidate: string): void => {
        const absolute = resolve(candidate)
        const fromRoot = relative(root, absolute)
        if (
            fromRoot === "" ||
            fromRoot === ".." ||
            fromRoot.startsWith(`..${sep}`) ||
            isAbsolute(fromRoot) ||
            !existsSync(join(absolute, "package.json"))
        ) return
        dirs.add(absolute)
    }

    for (const rawPattern of workspacePatterns(workspaces)) {
        const pattern = rawPattern.replace(/\\/g, "/").replace(/\/$/, "")
        if (!pattern.includes("*")) {
            addIfPackage(join(root, pattern))
            continue
        }
        if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) continue
        const parent = join(root, pattern.slice(0, -2))
        if (!existsSync(parent)) continue
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
            if (entry.isDirectory()) addIfPackage(join(parent, entry.name))
        }
    }

    return [...dirs].sort()
}

function supportedWorkspacePattern(pattern: string): boolean {
    const normalized = pattern.replace(/\\/g, "/").replace(/\/$/, "")
    return (
        !normalized.startsWith("!") &&
        (!normalized.includes("*") ||
            (normalized.endsWith("/*") && !normalized.slice(0, -2).includes("*")))
    )
}

// Conventional final-gate commands for whatever the repo root declares. Only
// scripts that actually exist are included — a missing gate is a skip, never an
// invented command. The deterministic RunVerifier owns these after all story
// commits are integrated; they must not become separate LLM stories.
function detectCommands(cwd: string): VerifyCommandSpec[] {
    const cmds: VerifyCommandSpec[] = []

    const pkgPath = join(cwd, "package.json")
    const hasPackageManifest = existsSync(pkgPath)
    const hasPnpmWorkspace = existsSync(join(cwd, "pnpm-workspace.yaml"))
    if (hasPackageManifest || hasPnpmWorkspace) {
        const manifest = hasPackageManifest ? readPackageManifest(pkgPath) : null
        if (hasPackageManifest && !manifest) {
            cmds.push({
                label: "parse package.json",
                tool: "node",
                args: [],
                preflightFailure: "package.json is not valid JSON",
            })
        }
        const scripts = manifest?.scripts ?? {}
        const pm = existsSync(join(cwd, "pnpm-lock.yaml"))
            || hasPnpmWorkspace
            ? "pnpm"
            : existsSync(join(cwd, "yarn.lock"))
              ? "yarn"
              : "npm"
        const declaredWorkspacePatterns = [
            ...workspacePatterns(manifest?.workspaces),
            ...pnpmWorkspacePatterns(cwd),
        ]
        const unsupportedPatterns = declaredWorkspacePatterns.filter(
            (pattern) => !supportedWorkspacePattern(pattern),
        )
        for (const pattern of unsupportedPatterns) {
            cmds.push({
                label: `resolve workspace pattern ${pattern}`,
                tool: "node",
                args: [],
                preflightFailure:
                    `unsupported workspace pattern '${pattern}'; configure an explicit verification command`,
            })
        }
        const workspaceDirs = workspacePackageDirs(
            cwd,
            declaredWorkspacePatterns.filter(supportedWorkspacePattern),
        )
        const workspaces = workspaceDirs.map((workspaceCwd) => ({
            cwd: workspaceCwd,
            manifest: readPackageManifest(join(workspaceCwd, "package.json")),
        }))
        for (const workspace of workspaces) {
            if (workspace.manifest) continue
            const displayCwd = relative(cwd, workspace.cwd).replace(/\\/g, "/")
            cmds.push({
                label: `parse ${displayCwd}/package.json`,
                tool: "node",
                args: [],
                preflightFailure: `${displayCwd}/package.json is not valid JSON`,
            })
        }
        for (const script of ["build", "typecheck", "test", "lint"] as const) {
            if (typeof scripts[script] === "string") {
                cmds.push({
                    label: `${pm} run ${script}`,
                    tool: pm,
                    args: ["run", script],
                })
                continue
            }

            // A workspace root often delegates no scripts of its own. Verify
            // each package that explicitly declares the command; otherwise a
            // monorepo such as Baro would silently check only its Rust half.
            for (const workspace of workspaces) {
                if (typeof workspace.manifest?.scripts?.[script] !== "string") continue
                const displayCwd = relative(cwd, workspace.cwd).replace(/\\/g, "/")
                cmds.push({
                    label: `${pm} run ${script} (${displayCwd})`,
                    tool: pm,
                    args: ["run", script],
                    cwd: workspace.cwd,
                })
            }
        }
    }

    if (existsSync(join(cwd, "Cargo.toml"))) {
        cmds.push({ label: "cargo build", tool: "cargo", args: ["build"] })
        cmds.push({ label: "cargo test", tool: "cargo", args: ["test"] })
    }

    if (existsSync(join(cwd, "go.mod"))) {
        cmds.push({ label: "go build ./...", tool: "go", args: ["build", "./..."] })
        cmds.push({ label: "go test ./...", tool: "go", args: ["test", "./..."] })
    }

    return cmds
}

/** Freeze command discovery before workers can edit manifests or remove scripts. */
export function createVerifyPlan(cwd: string): VerifyPlan {
    return freezeVerifyPlan(detectCommands(cwd))
}

/**
 * Preserve every trusted pre-run command while also admitting conventional
 * final-gate commands that only exist after the stories are integrated.
 *
 * Keeping the baseline first means an agent cannot turn a required check into
 * a skip by deleting it. Adding the final snapshot closes the opposite gap:
 * a story that introduces the project's first test script is actually tested.
 */
export function mergeVerifyPlans(...plans: readonly VerifyPlan[]): VerifyPlan {
    const commands: VerifyCommandSpec[] = []
    const seen = new Set<string>()
    for (const plan of plans) {
        for (const command of plan.commands) {
            const key = JSON.stringify([
                command.label,
                command.tool,
                command.args,
                command.cwd ?? null,
                command.preflightFailure ?? null,
            ])
            if (seen.has(key)) continue
            seen.add(key)
            commands.push(command)
        }
    }
    return freezeVerifyPlan(commands)
}

function freezeVerifyPlan(commands: readonly VerifyCommandSpec[]): VerifyPlan {
    return Object.freeze({
        commands: Object.freeze(
            commands.map((command) =>
                Object.freeze({
                    ...command,
                    args: Object.freeze([...command.args]),
                }),
            ),
        ),
    })
}

/** Worst-case command budget plus one minute for mailbox/process teardown. */
export function recommendedVerifyTimeoutMs(plan: VerifyPlan): number {
    const executableCommands = plan.commands.filter(
        (command) => !command.preflightFailure,
    ).length
    return Math.max(60_000, executableCommands * TIMEOUT_MS + 60_000)
}

type CmdOutcome =
    | { status: "passed"; durationMs: number }
    | { status: "failed"; durationMs: number; tail: string }
    | { status: "skipped"; durationMs: number; tail: string }

async function runCmd(
    cwd: string,
    c: VerifyCommandSpec,
    signal?: AbortSignal,
): Promise<CmdOutcome> {
    const startedAt = Date.now()
    if (c.preflightFailure) {
        return {
            status: "failed",
            durationMs: 0,
            tail: c.preflightFailure,
        }
    }
    const commandCwd = c.cwd ?? cwd
    if (!existsSync(commandCwd)) {
        return {
            status: "failed",
            durationMs: 0,
            tail: `verification working directory is missing: ${commandCwd}`,
        }
    }
    throwIfAborted(signal)
    try {
        await execFileAsync(c.tool, [...c.args], {
            cwd: commandCwd,
            timeout: TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            shell: process.platform === "win32",
            signal,
        })
        return { status: "passed", durationMs: Date.now() - startedAt }
    } catch (e) {
        if (signal?.aborted) throw e
        // Tool not installed → we couldn't verify with it. Not a failure.
        if ((e as { code?: string }).code === "ENOENT") {
            return {
                status: "skipped",
                durationMs: Date.now() - startedAt,
                tail: `${c.tool} is not installed`,
            }
        }
        const err = e as { stdout?: string; stderr?: string; message?: string }
        const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || ""
        return {
            status: "failed",
            durationMs: Date.now() - startedAt,
            tail: combined.slice(-TAIL_BYTES),
        }
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error("verification cancelled")
}

/**
 * Run the detected final-gate commands at `cwd` (the merged branch), best-effort.
 * Runs every detectable command even if an earlier one fails, so the PR body can
 * surface all the problems at once.
 */
export async function verifyBuild(
    cwd: string,
    options: VerifyBuildOptions = {},
): Promise<VerifyResult> {
    const failures: Array<{ cmd: string; tail: string }> = []
    const commands: VerifyCommandResult[] = []
    let ran = false
    const plan = options.plan ?? createVerifyPlan(cwd)
    for (const c of plan.commands) {
        throwIfAborted(options.signal)
        const outcome = await runCmd(cwd, c, options.signal)
        commands.push({
            command: c.label,
            status: outcome.status,
            durationMs: outcome.durationMs,
            ...("tail" in outcome && outcome.tail ? { tail: outcome.tail } : {}),
        })
        if (outcome.status === "skipped") continue
        ran = true
        if (outcome.status === "failed") failures.push({ cmd: c.label, tail: outcome.tail })
    }
    return { ran, ok: failures.length === 0, failures, commands }
}
