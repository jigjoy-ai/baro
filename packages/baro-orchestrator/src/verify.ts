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
 *                not a command failure, but run-level policy treats it as an
 *                incomplete gate rather than a verified pass.
 *   - ok=false   only when a build/test that ACTUALLY RAN returned non-zero.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { execFileCli } from "./exec-file-cli.js"
import {
    MAX_DECLARED_VERIFY_COMMANDS,
    revalidateContainedPaths,
    translateDeclaredTests,
} from "./declared-verification.js"

export { MAX_DECLARED_VERIFY_COMMANDS } from "./declared-verification.js"

const TIMEOUT_MS = 5 * 60_000
const COMMAND_SETTLEMENT_GRACE_MS = 5_000
const COMMAND_PROCESS_TREE_QUIESCENCE_BUDGET_MS = 3_000
const MAX_DECLARED_TRANSLATION_INPUTS = 64
const TAIL_BYTES = 1500
/** Includes conventional commands added at runtime as well as PRD declarations. */
export const MAX_FINAL_ADDED_VERIFY_COMMANDS = 8

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
    /** A declared requirement that could not be translated without a shell. */
    incompleteReason?: string
    /** Canonical identity for duplicate incomplete PRD requirements. */
    declaredRequirementKey?: string
    /** Paths that must still resolve beneath command cwd immediately pre-spawn. */
    containedPaths?: readonly VerifyContainedPath[]
}

export interface VerifyContainedPath {
    readonly path: string
    readonly requireFile: boolean
    /** Focus arguments may name not-yet-created contained paths. */
    readonly allowMissing?: boolean
}

export interface DeclaredTestRequirement {
    /** PRD story that owns this requirement; used only in evidence. */
    readonly storyId: string
    /** Human-authored PRD command. It is parsed, never passed to a shell. */
    readonly command: string
    /** Raw-schema defect that must remain explicit instead of normalizing away. */
    readonly declarationError?: string
}

export interface VerifyPlanOptions {
    /** Authoritative tests from the PRD snapshot being verified. */
    readonly declaredTests?: readonly DeclaredTestRequirement[]
}

export interface VerifyPlan {
    readonly commands: readonly VerifyCommandSpec[]
    /**
     * Package-manager choices captured with this snapshot. The root entry has
     * no cwd; workspace entries use the same absolute cwd as command specs.
     *
     * Optional for backwards compatibility with caller-authored plans. Plans
     * returned by createVerifyPlan always populate it, even when no JS scripts
     * existed yet, so final-added gates cannot switch package managers.
     */
    readonly javascriptPackageManagers?: readonly VerifyJavaScriptPackageManager[]
}

export interface VerifyBuildOptions {
    /** Cancels the current child and prevents later commands from starting. */
    signal?: AbortSignal
    /** Snapshotted before agents mutate the target repo. */
    plan?: VerifyPlan
}

interface PackageManifest {
    packageManager?: unknown
    scripts?: Record<string, unknown>
    workspaces?: unknown
}

export type JavaScriptPackageManager = "npm" | "pnpm" | "yarn"

export interface VerifyJavaScriptPackageManager {
    /** Omitted for the repository root; absolute for a workspace package. */
    readonly cwd?: string
    readonly manager: JavaScriptPackageManager
    /** Present only when package.json declared `<manager>@<version>`. */
    readonly declaredVersion?: string
}

interface DeclaredPackageManager {
    manager: JavaScriptPackageManager
    version: string
}

/**
 * package.json's packageManager field uses the Corepack form
 * `<manager>@<version>`. A present, non-empty malformed declaration and a
 * well-formed declaration for an unsupported manager are handled separately
 * as deterministic verification failures instead of silently invoking a
 * different package manager.
 */
function declaredPackageManager(value: unknown): DeclaredPackageManager | null {
    if (typeof value !== "string") return null
    const match = value.match(/^(npm|pnpm|yarn)@([^\s@]+)$/)
    if (!match) return null
    return {
        manager: match[1] as JavaScriptPackageManager,
        version: match[2]!,
    }
}

function unsupportedDeclaredPackageManager(value: unknown): string | null {
    if (typeof value !== "string") return null
    const match = value.match(/^([^\s@]+)@[^\s@]+$/)
    if (!match || /^(npm|pnpm|yarn)$/.test(match[1]!)) return null
    return match[1]!
}

function malformedDeclaredPackageManager(value: unknown): string | null {
    if (value === undefined || value === null) return null
    if (typeof value === "string" && value.trim() === "") return null
    if (
        declaredPackageManager(value) ||
        unsupportedDeclaredPackageManager(value)
    ) return null
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        return String(value)
    }
}

function detectPackageManager(
    cwd: string,
    manifest: PackageManifest | null,
    hasPnpmWorkspace: boolean,
): JavaScriptPackageManager {
    const declared = declaredPackageManager(manifest?.packageManager)
    if (declared) return declared.manager

    // Preserve pnpm workspace semantics, then resolve conflicting npm/Yarn
    // lockfiles deterministically in favour of package-lock.json. Repositories
    // can always override lockfile inference with a valid packageManager field.
    if (existsSync(join(cwd, "pnpm-lock.yaml")) || hasPnpmWorkspace) return "pnpm"
    if (existsSync(join(cwd, "package-lock.json"))) return "npm"
    if (existsSync(join(cwd, "yarn.lock"))) return "yarn"
    return "npm"
}

function packageManagerCommand(
    pm: JavaScriptPackageManager,
    declared: DeclaredPackageManager | null,
    script: string,
    trailingArgs: readonly string[] = [],
): Pick<VerifyCommandSpec, "tool" | "args"> {
    // Yarn 2+ intentionally relies on Corepack. Calling a bare `yarn` binary
    // can otherwise execute an unrelated global Yarn 1 installation.
    const yarnMajor = declared?.manager === "yarn"
        ? Number.parseInt(declared.version.match(/^\d+/)?.[0] ?? "", 10)
        : Number.NaN
    if (pm === "yarn" && yarnMajor >= 2) {
        return {
            tool: "corepack",
            args: ["yarn", "run", script, ...trailingArgs],
        }
    }
    return { tool: pm, args: ["run", script, ...trailingArgs] }
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
interface DetectedVerifyPlan {
    commands: VerifyCommandSpec[]
    javascriptPackageManagers: VerifyJavaScriptPackageManager[]
}

function detectCommands(cwd: string): DetectedVerifyPlan {
    const cmds: VerifyCommandSpec[] = []
    const javascriptPackageManagers: VerifyJavaScriptPackageManager[] = []

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
        const declared = declaredPackageManager(manifest?.packageManager)
        const unsupportedManager = unsupportedDeclaredPackageManager(
            manifest?.packageManager,
        )
        const malformedManager = malformedDeclaredPackageManager(
            manifest?.packageManager,
        )
        const managerResolutionFailed = unsupportedManager !== null
            || malformedManager !== null
        const pm = detectPackageManager(cwd, manifest, hasPnpmWorkspace)
        if (unsupportedManager) {
            cmds.push({
                label: `resolve package manager ${unsupportedManager}`,
                tool: "node",
                args: [],
                preflightFailure:
                    `unsupported packageManager '${String(manifest?.packageManager)}'; ` +
                    "supported managers are npm, pnpm, and yarn",
            })
        }
        if (malformedManager) {
            cmds.push({
                label: "resolve package manager declaration",
                tool: "node",
                args: [],
                preflightFailure:
                    `malformed packageManager ${malformedManager}; ` +
                    "expected npm@<version>, pnpm@<version>, or yarn@<version>",
            })
        }
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
        if (!managerResolutionFailed) {
            const managerSnapshot = {
                manager: pm,
                ...(declared ? { declaredVersion: declared.version } : {}),
            }
            javascriptPackageManagers.push(managerSnapshot)
            for (const workspace of workspaces) {
                javascriptPackageManagers.push({
                    cwd: workspace.cwd,
                    ...managerSnapshot,
                })
            }
        }
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
        for (const script of managerResolutionFailed
            ? []
            : (["build", "typecheck", "test", "lint"] as const)) {
            if (typeof scripts[script] === "string") {
                const command = packageManagerCommand(pm, declared, script)
                cmds.push({
                    label: `${pm} run ${script}`,
                    ...command,
                })
                continue
            }

            // A workspace root often delegates no scripts of its own. Verify
            // each package that explicitly declares the command; otherwise a
            // monorepo such as Baro would silently check only its Rust half.
            for (const workspace of workspaces) {
                if (typeof workspace.manifest?.scripts?.[script] !== "string") continue
                const displayCwd = relative(cwd, workspace.cwd).replace(/\\/g, "/")
                const command = packageManagerCommand(pm, declared, script)
                cmds.push({
                    label: `${pm} run ${script} (${displayCwd})`,
                    ...command,
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

    return { commands: cmds, javascriptPackageManagers }
}

function dedupeVerifyCommands(
    commands: readonly VerifyCommandSpec[],
): VerifyCommandSpec[] {
    const deduped: VerifyCommandSpec[] = []
    const seen = new Set<string>()
    for (const command of commands) {
        const identity = verifyCommandIdentity(command)
        if (seen.has(identity)) continue
        seen.add(identity)
        deduped.push(command)
    }
    return deduped
}

function boundedDeclaredCommands(
    automatic: readonly VerifyCommandSpec[],
    declared: readonly VerifyCommandSpec[],
): VerifyCommandSpec[] {
    const commands = dedupeVerifyCommands(automatic)
    const seen = new Set(commands.map(verifyCommandIdentity))
    let admitted = 0
    let omitted = 0
    for (const command of declared) {
        const identity = verifyCommandIdentity(command)
        if (seen.has(identity)) continue
        seen.add(identity)
        if (admitted >= MAX_DECLARED_VERIFY_COMMANDS) {
            omitted += 1
            continue
        }
        admitted += 1
        commands.push(command)
    }
    if (omitted > 0) {
        commands.push({
            label: "PRD verification requirements beyond bounded budget",
            tool: "node",
            args: [],
            incompleteReason:
                `${omitted} unique PRD test requirement(s) were not admitted; ` +
                `the safe limit is ${MAX_DECLARED_VERIFY_COMMANDS}`,
        })
    }
    return commands
}

/** Freeze command discovery before workers can edit manifests or remove scripts. */
export function createVerifyPlan(
    cwd: string,
    options: VerifyPlanOptions = {},
): VerifyPlan {
    const detected = detectCommands(cwd)
    const declaredInputs = options.declaredTests ?? []
    const declaredCommands = translateDeclaredTests(
        cwd,
        declaredInputs.slice(0, MAX_DECLARED_TRANSLATION_INPUTS),
        detected.javascriptPackageManagers,
    )
    if (declaredInputs.length > MAX_DECLARED_TRANSLATION_INPUTS) {
        declaredCommands.unshift({
            label: "PRD verification input beyond translation budget",
            tool: "node",
            args: [],
            incompleteReason:
                `${declaredInputs.length - MAX_DECLARED_TRANSLATION_INPUTS} ` +
                "declared test input(s) were not translated",
            declaredRequirementKey: "<declared-translation-overflow>",
        })
    }
    return freezeVerifyPlan(
        boundedDeclaredCommands(detected.commands, declaredCommands),
        detected.javascriptPackageManagers,
    )
}

/**
 * Preserve every trusted pre-run executable command while also admitting
 * conventional final-gate commands that only exist after the stories are
 * integrated. Discovery/configuration failures are snapshot-local: only the
 * final snapshot is authoritative for them, so a story may repair a malformed
 * manifest while a regression introduced by a story still fails closed.
 *
 * Keeping the baseline first means an agent cannot turn a required check into
 * a skip by deleting it. Adding the final snapshot closes the opposite gap:
 * a story that introduces the project's first test script is actually tested.
 */
export function mergeVerifyPlans(...plans: readonly VerifyPlan[]): VerifyPlan {
    const commands: VerifyCommandSpec[] = []
    const seen = new Set<string>()
    const managerAuthorities = new Map<string, VerifyJavaScriptPackageManager>()
    const packageManagers: VerifyJavaScriptPackageManager[] = []
    const finalPlanIndex = plans.length - 1
    let finalAddedExecutableCommands = 0
    let omittedFinalCommands = 0
    for (const [planIndex, plan] of plans.entries()) {
        // The first snapshot establishes trusted manager choices before any
        // command is considered. Later snapshots can establish authority only
        // for packages that had no baseline/root authority at all.
        if (planIndex === 0) {
            registerPackageManagerAuthorities(
                plan.javascriptPackageManagers,
                managerAuthorities,
                packageManagers,
            )
        }
        for (const command of plan.commands) {
            // A preflight failure describes the manifest/configuration in one
            // snapshot; retaining an older one would make that state
            // impossible for a story to repair. Executable gates remain
            // baseline-first and frozen below.
            if (
                plans.length > 1 &&
                planIndex !== finalPlanIndex &&
                (command.preflightFailure || command.incompleteReason)
            ) continue
            const authoritativeCommand = planIndex === 0
                ? command
                : rewriteJavaScriptCommandForAuthority(command, managerAuthorities)
            const key = verifyCommandIdentity(authoritativeCommand)
            if (seen.has(key)) continue
            seen.add(key)
            const executable =
                !authoritativeCommand.preflightFailure &&
                !authoritativeCommand.incompleteReason
            if (
                planIndex > 0 &&
                executable &&
                finalAddedExecutableCommands >= MAX_FINAL_ADDED_VERIFY_COMMANDS
            ) {
                omittedFinalCommands += 1
                continue
            }
            if (planIndex > 0 && executable) finalAddedExecutableCommands += 1
            commands.push(authoritativeCommand)
        }
        if (planIndex !== 0) {
            registerPackageManagerAuthorities(
                plan.javascriptPackageManagers,
                managerAuthorities,
                packageManagers,
                true,
            )
        }
    }
    if (omittedFinalCommands > 0) {
        commands.push({
            label: "final verification additions beyond bounded budget",
            tool: "node",
            args: [],
            incompleteReason:
                `${omittedFinalCommands} final command(s) were not executed; ` +
                `the adaptive verification limit is ${MAX_FINAL_ADDED_VERIFY_COMMANDS}`,
        })
    }
    return freezeVerifyPlan(commands, packageManagers)
}

const ROOT_PACKAGE_MANAGER_KEY = "<root>"

function packageManagerKey(cwd?: string): string {
    return cwd ?? ROOT_PACKAGE_MANAGER_KEY
}

function registerPackageManagerAuthorities(
    managers: readonly VerifyJavaScriptPackageManager[] | undefined,
    authorities: Map<string, VerifyJavaScriptPackageManager>,
    collected: VerifyJavaScriptPackageManager[],
    preserveExistingRoot = false,
): void {
    for (const manager of managers ?? []) {
        const key = packageManagerKey(manager.cwd)
        if (
            preserveExistingRoot &&
            manager.cwd !== undefined &&
            authorities.has(ROOT_PACKAGE_MANAGER_KEY)
        ) continue
        if (authorities.has(key)) continue
        authorities.set(key, manager)
        collected.push(manager)
    }
}

interface JavaScriptCommandDetails {
    manager: JavaScriptPackageManager
    script: string
    trailingArgs: readonly string[]
}

function javascriptCommandDetails(
    command: VerifyCommandSpec,
): JavaScriptCommandDetails | null {
    if (
        /^(npm|pnpm|yarn)$/.test(command.tool) &&
        command.args[0] === "run" &&
        typeof command.args[1] === "string"
    ) {
        return {
            manager: command.tool as JavaScriptPackageManager,
            script: command.args[1],
            trailingArgs: command.args.slice(2),
        }
    }
    if (
        command.tool === "corepack" &&
        /^(npm|pnpm|yarn)$/.test(command.args[0] ?? "") &&
        command.args[1] === "run" &&
        typeof command.args[2] === "string"
    ) {
        return {
            manager: command.args[0] as JavaScriptPackageManager,
            script: command.args[2],
            trailingArgs: command.args.slice(3),
        }
    }
    return null
}

function rewriteJavaScriptCommandForAuthority(
    command: VerifyCommandSpec,
    authorities: ReadonlyMap<string, VerifyJavaScriptPackageManager>,
): VerifyCommandSpec {
    const details = javascriptCommandDetails(command)
    if (!details) return command
    // A baseline root manager governs newly introduced workspace packages too;
    // exact workspace snapshots win when one already existed before the run.
    const authority = authorities.get(packageManagerKey(command.cwd))
        ?? authorities.get(ROOT_PACKAGE_MANAGER_KEY)
    if (!authority) return command
    const declared = authority.declaredVersion
        ? { manager: authority.manager, version: authority.declaredVersion }
        : null
    const rewritten = packageManagerCommand(
        authority.manager,
        declared,
        details.script,
        details.trailingArgs,
    )
    return {
        ...command,
        label: command.label.replace(
            new RegExp(`^${details.manager}(?= run )`),
            authority.manager,
        ),
        ...rewritten,
    }
}

/**
 * JS package-manager commands are the same gate when they run the same named
 * script in the same package. This deliberately omits the manager/tool: plans
 * are merged baseline-first, so an agent cannot cause the final verifier to
 * invoke a second manager merely by changing packageManager or a lockfile.
 */
function verifyCommandIdentity(command: VerifyCommandSpec): string {
    if (command.declaredRequirementKey) {
        return JSON.stringify([
            "declared-requirement",
            command.declaredRequirementKey,
        ])
    }
    const details = javascriptCommandDetails(command)
    if (details) {
        return JSON.stringify([
            "javascript-script",
            command.cwd ?? null,
            details.script,
            details.trailingArgs,
            command.containedPaths ?? null,
        ])
    }
    return JSON.stringify([
        command.label,
        command.tool,
        command.args,
        command.cwd ?? null,
        command.preflightFailure ?? null,
        command.incompleteReason ?? null,
        command.declaredRequirementKey ?? null,
        command.containedPaths ?? null,
    ])
}

function freezeVerifyPlan(
    commands: readonly VerifyCommandSpec[],
    javascriptPackageManagers: readonly VerifyJavaScriptPackageManager[] = [],
): VerifyPlan {
    return Object.freeze({
        commands: Object.freeze(
            commands.map((command) =>
                Object.freeze({
                    ...command,
                    args: Object.freeze([...command.args]),
                    ...(command.containedPaths
                        ? {
                              containedPaths: Object.freeze(
                                  command.containedPaths.map((path) =>
                                      Object.freeze({ ...path }),
                                  ),
                              ),
                          }
                        : {}),
                }),
            ),
        ),
        javascriptPackageManagers: Object.freeze(
            javascriptPackageManagers.map((manager) => Object.freeze({ ...manager })),
        ),
    })
}

/** Worst-case command budget plus one minute for mailbox/process teardown. */
export function recommendedVerifyTimeoutMs(plan: VerifyPlan): number {
    const executableCommands = plan.commands.filter(
        (command) => !command.preflightFailure && !command.incompleteReason,
    ).length
    return Math.max(
        60_000,
        executableCommands * (TIMEOUT_MS + COMMAND_SETTLEMENT_GRACE_MS) +
            executableCommands * COMMAND_PROCESS_TREE_QUIESCENCE_BUDGET_MS +
            60_000,
    )
}

/**
 * Default watchdog for a baseline plus the largest final-plan delta that
 * mergeVerifyPlans can admit. The verifier therefore cannot create a valid
 * bounded plan whose own per-command budgets systematically exceed the Board.
 */
export function recommendedMergedVerifyTimeoutMs(baseline: VerifyPlan): number {
    const baselineCommands = baseline.commands.filter(
        (command) => !command.preflightFailure && !command.incompleteReason,
    ).length
    return (
        (baselineCommands + MAX_FINAL_ADDED_VERIFY_COMMANDS) *
            (TIMEOUT_MS +
                COMMAND_SETTLEMENT_GRACE_MS +
                COMMAND_PROCESS_TREE_QUIESCENCE_BUDGET_MS) +
        60_000
    )
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
    if (c.incompleteReason) {
        return {
            status: "skipped",
            durationMs: 0,
            tail: c.incompleteReason,
        }
    }
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
    if (c.containedPaths) {
        const containmentFailure = revalidateContainedPaths(
            commandCwd,
            c.containedPaths,
        )
        if (containmentFailure) {
            return {
                status: "skipped",
                durationMs: Date.now() - startedAt,
                tail: containmentFailure,
            }
        }
    }
    try {
        await execFileCli(c.tool, c.args, {
            cwd: commandCwd,
            timeout: TIMEOUT_MS,
            terminationGraceMs: COMMAND_SETTLEMENT_GRACE_MS,
            maxBuffer: 8 * 1024 * 1024,
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
