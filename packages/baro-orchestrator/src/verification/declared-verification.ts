/**
 * Strict translation policy for human-authored PRD test requirements.
 *
 * Nothing in this module invokes a shell. A requirement either becomes a
 * structured tool/argv command from the narrow allowlist below, or explicit
 * skipped/incomplete evidence consumed by the run-level verifier.
 */

import {
    existsSync,
    readFileSync,
    realpathSync,
    statSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import type {
    DeclaredTestRequirement,
    VerifyCommandSpec,
    VerifyContainedPath,
    VerifyJavaScriptPackageManager,
} from "./verify.js"

const MAX_COMMAND_LENGTH = 1_000
export const MAX_DECLARED_VERIFY_COMMANDS = 8
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_.:-]+$/
const TRUSTED_PACKAGE_SCRIPTS = new Set(["build", "typecheck", "test", "lint"])
// Deliberately separate from TRUSTED_PACKAGE_SCRIPTS: `check` is the
// Composer-conventional gate name, and neither set may widen the other.
const TRUSTED_COMPOSER_SCRIPTS = new Set([
    "build",
    "typecheck",
    "test",
    "lint",
    "check",
])
const SAFE_TOKEN = /^[A-Za-z0-9_./:@+=,-]+$/
const SAFE_CARGO_VALUE = /^[A-Za-z0-9_+.-]+(?:,[A-Za-z0-9_+.-]+)*$/
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

interface PackageManifest {
    name?: unknown
    scripts?: Record<string, unknown>
    workspaces?: unknown
}

interface DeclaredTokens {
    readonly normalized: string
    readonly tokens: readonly string[]
}

export function translateDeclaredTests(
    cwd: string,
    requirements: readonly DeclaredTestRequirement[],
    packageManagers: readonly VerifyJavaScriptPackageManager[],
): VerifyCommandSpec[] {
    return requirements.map((requirement) => {
        if (requirement.declarationError) {
            return incomplete(requirement, requirement.declarationError)
        }
        const parsed = tokenize(requirement.command)
        if (typeof parsed === "string") return incomplete(requirement, parsed)
        return dispatchDeclared(
            cwd,
            requirement,
            parsed,
            packageManagers,
            false,
        )
    })
}

// Re-entrant so `ddev exec <inner>` re-applies this exact policy to the
// wrapped command; declarationError and tokenize stay in the caller so an
// inner command is never re-parsed.
function dispatchDeclared(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
    packageManagers: readonly VerifyJavaScriptPackageManager[],
    insideDdev: boolean,
): VerifyCommandSpec {
    // A declaration that is byte-identical to a trusted package script's
    // body IS that script (planners often copy "node test.js" out of
    // package.json). Route it through the script policy instead of
    // skipping semantics the manifest already declares runnable.
    const aliasScript = trustedScriptAlias(cwd, parsed.tokens)
    if (aliasScript) {
        const aliasTokens = tokenize(`npm run ${aliasScript}`)
        if (typeof aliasTokens !== "string") {
            return translatePackage(
                cwd,
                requirement,
                aliasTokens,
                packageManagers,
            )
        }
    }
    const tool = parsed.tokens[0]
    if (/^(npm|pnpm|yarn)$/.test(tool ?? "")) {
        return translatePackage(cwd, requirement, parsed, packageManagers)
    }
    if (tool === "npx") {
        return translateNpxRstest(
            cwd,
            requirement,
            parsed,
            packageManagers,
        )
    }
    if (tool === "cargo") return translateCargo(cwd, requirement, parsed)
    if (tool === "node") return translateNode(cwd, requirement, parsed)
    if (
        tool === "git" &&
        parsed.tokens.length === 3 &&
        parsed.tokens[1] === "diff" &&
        parsed.tokens[2] === "--check"
    ) {
        return {
            label: "git diff --check",
            tool: "git",
            args: ["diff", "--no-ext-diff", "--no-textconv", "--check"],
        }
    }
    if (tool === "composer") return translateComposer(cwd, requirement, parsed)
    if (tool === "vendor/bin/phpunit") {
        return translatePhpunit(cwd, requirement, parsed)
    }
    if (tool === "ddev") {
        return translateDdev(
            cwd,
            requirement,
            parsed,
            packageManagers,
            insideDdev,
        )
    }
    return incomplete(
        requirement,
        "unsupported declared test; allowed tools are npm/pnpm/yarn, exact npx rstest run paths, cargo, node, git diff --check, composer, vendor/bin/phpunit, and ddev exec",
    )
}

// Only a whole token wrapped in a matching quote pair is unwrapped, and the
// unwrapped value still faces SAFE_TOKEN — so quoting can never express more
// than the bare token could. Anything else (stray, mid-token, or nested
// quote, empty body) is null and stays rejected.
function unwrapQuotedToken(token: string): string | null {
    if (!/["']/.test(token)) return token
    if (
        token.length >= 2 &&
        (token[0] === '"' || token[0] === "'") &&
        token[token.length - 1] === token[0]
    ) {
        const inner = token.slice(1, -1)
        return inner === "" || /["']/.test(inner) ? null : inner
    }
    return null
}

function tokenize(command: unknown): DeclaredTokens | string {
    if (typeof command !== "string") {
        return "declared test is empty"
    }
    if (command.length > MAX_COMMAND_LENGTH) {
        return `declared test exceeds ${MAX_COMMAND_LENGTH} characters`
    }
    const normalized = command.trim()
    if (normalized === "") return "declared test is empty"
    if (/[^A-Za-z0-9_./:@+=,\-\s"']/.test(normalized)) {
        return "declared test contains unsupported quoting, shell, or glob syntax"
    }
    if (/[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
        return "declared test contains control characters"
    }
    const raw = normalized.split(/\s+/)
    const tokens: string[] = []
    for (const token of raw) {
        const unwrapped = unwrapQuotedToken(token)
        if (unwrapped === null) {
            return "declared test contains unsupported quoting, shell, or glob syntax"
        }
        tokens.push(unwrapped)
    }
    if (tokens.some((token) => !SAFE_TOKEN.test(token))) {
        return "declared test contains an unsupported argument"
    }
    return { normalized: tokens.join(" "), tokens }
}

function incomplete(
    requirement: DeclaredTestRequirement,
    reason: string,
): VerifyCommandSpec {
    const normalizedRequirement = typeof requirement.command === "string"
        ? requirement.command.length > MAX_COMMAND_LENGTH
            ? `<overlong command:${requirement.command.length}>`
            : requirement.command.trim().split(/\s+/).join(" ")
        : "<invalid command value>"
    const storyId = typeof requirement.storyId === "string"
        ? requirement.storyId
              .replace(/[\r\n\t]+/g, " ")
              .replace(/[^A-Za-z0-9_.: -]/g, "?")
              .trim()
              .slice(0, 80)
        : ""
    const command = typeof requirement.command === "string"
        ? requirement.command
              .slice(0, 160)
              .replace(/[\r\n\t]+/g, " ")
              .replace(/[^A-Za-z0-9_./:@+=, -]/g, "?")
              .trim()
        : "(invalid command value)"
    return {
        label:
            `PRD test ${storyId || "unknown story"}: ` +
            (command || "(empty test)"),
        tool: "node",
        args: [],
        incompleteReason: reason,
        declaredRequirementKey: createHash("sha256")
            .update(JSON.stringify([normalizedRequirement, reason]))
            .digest("hex"),
    }
}

function readManifest(path: string): PackageManifest | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as PackageManifest
    } catch {
        return null
    }
}

function packageCommand(
    authority: VerifyJavaScriptPackageManager,
    script: string,
    trailingArgs: readonly string[],
): Pick<VerifyCommandSpec, "tool" | "args"> {
    const yarnMajor = authority.manager === "yarn" && authority.declaredVersion
        ? Number.parseInt(
              authority.declaredVersion.match(/^\d+/)?.[0] ?? "",
              10,
          )
        : Number.NaN
    if (authority.manager === "yarn" && yarnMajor >= 2) {
        return {
            tool: "corepack",
            args: ["yarn", "run", script, ...trailingArgs],
        }
    }
    return {
        tool: authority.manager,
        args: ["run", script, ...trailingArgs],
    }
}

function exactRstestScript(value: unknown): boolean {
    return (
        typeof value === "string" &&
        !/[\r\n]/.test(value) &&
        value.trim() === "rstest run"
    )
}

function translateNpxRstest(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
    managers: readonly VerifyJavaScriptPackageManager[],
): VerifyCommandSpec {
    const [, executable, operation, ...focusedPaths] = parsed.tokens
    if (
        executable !== "rstest" ||
        operation !== "run" ||
        focusedPaths.length === 0
    ) {
        return incomplete(
            requirement,
            "npx declarations are limited to 'npx rstest run <relative test path...>'",
        )
    }
    if (focusedPaths.some((value) => !safeRstestFocusPath(cwd, value))) {
        return incomplete(
            requirement,
            "npx rstest focus paths contain an unsafe, non-path, or escaping value",
        )
    }

    const manifestPath = join(cwd, "package.json")
    const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : null
    if (!manifest || !exactRstestScript(manifest.scripts?.test)) {
        return incomplete(
            requirement,
            "npx rstest translation requires root package.json scripts.test to be exactly 'rstest run'",
        )
    }
    const authority = managers.find((manager) => manager.cwd === undefined)
    if (!authority) {
        return incomplete(
            requirement,
            "root package-manager authority could not be resolved safely",
        )
    }
    const trailingArgs = ["--", ...focusedPaths]
    return {
        label: [authority.manager, "run", "test", ...trailingArgs].join(" "),
        ...packageCommand(authority, "test", trailingArgs),
        containedPaths: focusedPaths.map(focusedPathRequirement),
        canonicalDeclaredFocus: "rstest",
    }
}

function trustedScriptAlias(
    cwd: string,
    tokens: readonly string[],
): string | null {
    const manifestPath = join(cwd, "package.json")
    if (!existsSync(manifestPath)) return null
    const manifest = readManifest(manifestPath)
    if (!manifest?.scripts) return null
    const normalized = tokens.join(" ")
    for (const script of TRUSTED_PACKAGE_SCRIPTS) {
        const body = manifest.scripts[script]
        if (
            typeof body === "string" &&
            body.trim().split(/\s+/u).join(" ") === normalized
        ) {
            return script
        }
    }
    return null
}

interface WorkspaceSelector {
    readonly name?: string
    /** The selector exactly as declared, so the label keeps its spelling. */
    readonly declared?: readonly string[]
    readonly rest: readonly string[]
    readonly reason?: string
}

// Runs before the '--' split so the surviving tokens reach the unchanged
// focused-argument policy in their original order.
function extractWorkspaceSelector(
    rest: readonly string[],
): WorkspaceSelector {
    const kept: string[] = []
    let name: string | undefined
    let declared: readonly string[] | undefined
    let index = 0
    for (; index < rest.length; index += 1) {
        const token = rest[index]!
        if (token === "--") break
        const equalsValue = token.startsWith("--workspace=")
            ? token.slice("--workspace=".length)
            : null
        if (token !== "-w" && token !== "--workspace" && equalsValue === null) {
            kept.push(token)
            continue
        }
        if (declared) {
            return {
                rest,
                reason: "package tests accept at most one workspace selector",
            }
        }
        if (equalsValue !== null) {
            if (equalsValue === "" || equalsValue.startsWith("-")) {
                return { rest, reason: "workspace selector requires a name" }
            }
            name = equalsValue
            declared = [token]
            continue
        }
        const value = rest[index + 1]
        if (value === undefined || value.startsWith("-")) {
            return { rest, reason: "workspace selector requires a name" }
        }
        name = value
        declared = [token, value]
        index += 1
    }
    for (; index < rest.length; index += 1) {
        const token = rest[index]!
        if (
            token === "-w" ||
            token === "--workspace" ||
            token.startsWith("--workspace=")
        ) {
            return {
                rest,
                reason: "workspace selector must appear before '--'",
            }
        }
        kept.push(token)
    }
    if (!declared) return { rest }
    return { name, declared, rest: kept }
}

interface WorkspaceAuthority {
    readonly authority?: VerifyJavaScriptPackageManager
    readonly reason?: string
}

// The plan carries no workspace names, only cwds, so a declared name is
// matched against the repo-relative directory first and the workspace
// manifest's own `name` second. Globs are never expanded.
function resolveWorkspaceAuthority(
    cwd: string,
    name: string,
    managers: readonly VerifyJavaScriptPackageManager[],
): WorkspaceAuthority {
    const declaredWorkspaces = readManifest(
        join(cwd, "package.json"),
    )?.workspaces
    const packages = (declaredWorkspaces as { packages?: unknown } | undefined)
        ?.packages
    if (!Array.isArray(declaredWorkspaces) && !Array.isArray(packages)) {
        return {
            reason:
                "workspace selector requires a 'workspaces' field in the root package.json",
        }
    }
    const candidates = managers.filter((manager) => manager.cwd !== undefined)
    const repoRelative = (manager: VerifyJavaScriptPackageManager): string =>
        relative(resolve(cwd), resolve(manager.cwd!)).replace(/\\/g, "/")
    const wanted = name
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "")
    const byPath = candidates.find(
        (manager) => repoRelative(manager) === wanted,
    )
    if (byPath) return { authority: byPath }
    const byName = candidates.find(
        (manager) =>
            readManifest(join(manager.cwd!, "package.json"))?.name === name,
    )
    if (byName) return { authority: byName }
    const known = [...new Set(candidates.map(repoRelative))].sort()
    return {
        reason: known.length > 0
            ? `unknown workspace '${name}': known workspaces are ${known.join(", ")}`
            : `unknown workspace '${name}': no workspace packages were resolved`,
    }
}

function translatePackage(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
    managers: readonly VerifyJavaScriptPackageManager[],
): VerifyCommandSpec {
    const [, operation, maybeScript, ...remaining] = parsed.tokens
    const script = operation === "test"
        ? "test"
        : operation === "run" && maybeScript
          ? maybeScript
          : null
    const declaredRest = operation === "test"
        ? parsed.tokens.slice(2)
        : remaining
    if (!script) {
        return incomplete(
            requirement,
            "package tests must use '<manager> test' or '<manager> run <script>'",
        )
    }
    if (!SAFE_SCRIPT_NAME.test(script)) {
        return incomplete(requirement, `unsafe package script name '${script}'`)
    }
    const selector = extractWorkspaceSelector(declaredRest)
    if (selector.reason) return incomplete(requirement, selector.reason)
    const rest = selector.rest

    let trailingArgs: readonly string[] = []
    let focusedArgs: readonly string[] = []
    if (rest.length > 0) {
        if (rest[0] !== "--") {
            return incomplete(
                requirement,
                "focused package-script arguments must follow a literal '--'",
            )
        }
        focusedArgs = rest.slice(1)
        if (focusedArgs.some((argument) => !safeFocusedArg(cwd, argument))) {
            return incomplete(
                requirement,
                "package-script arguments contain an unsafe or escaping value",
            )
        }
        if (focusedArgs.length > 0) trailingArgs = ["--", ...focusedArgs]
    }

    let workspace: VerifyJavaScriptPackageManager | undefined
    if (selector.name !== undefined) {
        const resolved = resolveWorkspaceAuthority(
            cwd,
            selector.name,
            managers,
        )
        if (!resolved.authority) {
            return incomplete(requirement, resolved.reason!)
        }
        workspace = resolved.authority
    }

    // A workspace selector moves every manifest question to that package:
    // the script it declares is the one the command will run.
    const manifestPath = join(workspace?.cwd ?? cwd, "package.json")
    const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : null
    if (!manifest) {
        return incomplete(
            requirement,
            workspace
                ? `declared package test requires a valid package.json in workspace '${selector.name}'`
                : "declared package test requires a valid root package.json",
        )
    }
    if (typeof manifest.scripts?.[script] !== "string") {
        return incomplete(
            requirement,
            workspace
                ? `workspace '${selector.name}' package.json does not declare script '${script}'`
                : `package.json does not declare script '${script}'`,
        )
    }
    if (!TRUSTED_PACKAGE_SCRIPTS.has(script)) {
        return incomplete(
            requirement,
            `custom package script '${script}' is not trusted by the baseline verifier policy`,
        )
    }
    const authority =
        workspace ?? managers.find((manager) => manager.cwd === undefined)
    if (!authority) {
        return incomplete(
            requirement,
            "root package-manager authority could not be resolved safely",
        )
    }
    const containedPaths = focusedArgs.map(focusedPathRequirement)
    return {
        label: [
            authority.manager,
            "run",
            script,
            ...(selector.declared ?? []),
            ...trailingArgs,
        ].join(" "),
        ...packageCommand(authority, script, trailingArgs),
        ...(workspace ? { cwd: workspace.cwd } : {}),
        ...(containedPaths.length > 0 ? { containedPaths } : {}),
        ...(script === "test" &&
        exactRstestScript(manifest.scripts?.test) &&
        focusedArgs.length > 0 &&
        focusedArgs.every((value) => safeRstestFocusPath(cwd, value))
            ? { canonicalDeclaredFocus: "rstest" as const }
            : {}),
    }
}

function hasParentTraversal(value: string): boolean {
    return (
        value === ".." ||
        value.startsWith("../") ||
        value.endsWith("/..") ||
        value.includes("/../") ||
        value.includes("=../") ||
        value.includes("=/../")
    )
}

function escapesRoot(cwd: string, candidate: string): boolean {
    const root = resolve(cwd)
    const absolute = resolve(root, candidate)
    const fromRoot = relative(root, absolute)
    if (
        fromRoot === ".." ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot)
    ) return true
    try {
        let existingAncestor = absolute
        while (!existsSync(existingAncestor)) {
            const parent = dirname(existingAncestor)
            if (parent === existingAncestor) return true
            existingAncestor = parent
        }
        const fromRealRoot = relative(
            realpathSync(root),
            realpathSync(existingAncestor),
        )
        return (
            fromRealRoot === ".." ||
            fromRealRoot.startsWith(`..${sep}`) ||
            isAbsolute(fromRealRoot)
        )
    } catch {
        return true
    }
}

function safeFocusedArg(cwd: string, value: string): boolean {
    const contextOverrides = [
        "--cwd",
        "--prefix",
        "--config",
        "--manifest",
        "--chdir",
        "--root",
        "--project",
    ]
    if (
        value === "" ||
        value === "--" ||
        value.startsWith("@") ||
        value.startsWith("-C") ||
        !SAFE_TOKEN.test(value) ||
        contextOverrides.some((prefix) =>
            value === prefix ||
            value.startsWith(`${prefix}=`) ||
            value.startsWith(`${prefix}-`),
        )
    ) return false
    const possiblePath = value.includes("=")
        ? value.slice(value.indexOf("=") + 1)
        : value
    if (
        URI_SCHEME.test(value) ||
        URI_SCHEME.test(possiblePath) ||
        isAbsolute(possiblePath) ||
        /^[A-Za-z]:\//.test(possiblePath) ||
        possiblePath.startsWith("@") ||
        possiblePath.includes("://") ||
        hasParentTraversal(possiblePath)
    ) return false
    const pathLike =
        possiblePath.includes("/") ||
        possiblePath.startsWith(".") ||
        existsSync(resolve(cwd, possiblePath))
    return !(pathLike && escapesRoot(cwd, possiblePath))
}

function safeRstestFocusPath(cwd: string, value: string): boolean {
    if (
        value.startsWith("-") ||
        value.includes("=") ||
        !safeFocusedArg(cwd, value)
    ) return false
    return (
        value.includes("/") ||
        value.startsWith(".") ||
        /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value)
    )
}

function focusedPathRequirement(value: string): VerifyContainedPath {
    const possiblePath = value.includes("=")
        ? value.slice(value.indexOf("=") + 1)
        : value
    // A runner-specific focus token can be a name, flag value, or path. Treat
    // every admitted value as a potential path for immediate pre-spawn
    // containment; nonexistent names remain valid within cwd.
    return { path: possiblePath, requireFile: false, allowMissing: true }
}

const CARGO_FLAGS = new Set([
    "--workspace",
    "--all",
    "--all-targets",
    "--all-features",
    "--locked",
    "--offline",
    "--no-default-features",
    "--release",
    "--lib",
    "--bins",
    "--tests",
    "--benches",
    "--examples",
])
const CARGO_VALUE_FLAGS = new Set([
    "-p",
    "--package",
    "--features",
    "--target",
    "--test",
    "--bin",
    "--example",
])
const CARGO_TEST_FLAGS = new Set(["--doc", "--no-run", "--no-fail-fast"])
const TEST_HARNESS_FLAGS = new Set([
    "--exact",
    "--nocapture",
    "--ignored",
    "--include-ignored",
    "--show-output",
])

function safeTestHarnessArgs(args: readonly string[]): boolean {
    let filters = 0
    for (const argument of args) {
        if (TEST_HARNESS_FLAGS.has(argument)) continue
        if (/^--test-threads=[1-9][0-9]*$/.test(argument)) continue
        if (
            !argument.startsWith("-") &&
            /^[A-Za-z0-9_.:-]+$/.test(argument) &&
            filters === 0
        ) {
            filters += 1
            continue
        }
        return false
    }
    return true
}

function safeCargoArgs(
    subcommand: "build" | "check" | "test" | "clippy",
    args: readonly string[],
): boolean {
    let testFilterSeen = false
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!
        if (argument === "--") {
            const trailing = args.slice(index + 1)
            if (subcommand === "test") return safeTestHarnessArgs(trailing)
            if (subcommand === "clippy") {
                return (
                    (trailing.length === 1 && trailing[0] === "-Dwarnings") ||
                    (trailing.length === 2 && trailing[0] === "-D" && trailing[1] === "warnings") ||
                    (trailing.length === 2 && trailing[0] === "--deny" && trailing[1] === "warnings")
                )
            }
            return false
        }
        if (CARGO_FLAGS.has(argument)) continue
        if (subcommand === "test" && CARGO_TEST_FLAGS.has(argument)) continue
        if (subcommand === "clippy" && argument === "--no-deps") continue
        if (CARGO_VALUE_FLAGS.has(argument)) {
            const value = args[index + 1]
            if (!value || !SAFE_CARGO_VALUE.test(value)) return false
            index += 1
            continue
        }
        const equals = argument.match(
            /^(--package|--features|--target|--test|--bin|--example)=(.+)$/,
        )
        if (equals) {
            if (!SAFE_CARGO_VALUE.test(equals[2]!)) return false
            continue
        }
        if (
            subcommand === "test" &&
            !testFilterSeen &&
            !argument.startsWith("-") &&
            /^[A-Za-z0-9_.:-]+$/.test(argument)
        ) {
            testFilterSeen = true
            continue
        }
        return false
    }
    return true
}

function canonicalCargoArgs(tokens: readonly string[]): string[] {
    const canonical: string[] = []
    for (const token of tokens) {
        if (token === "-p") {
            canonical.push("--package")
            continue
        }
        const equals = token.match(
            /^(--package|--features|--target|--test|--bin|--example)=(.+)$/,
        )
        if (equals) {
            canonical.push(equals[1]!, equals[2]!)
            continue
        }
        canonical.push(token)
    }
    return canonical
}

function translateCargo(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
): VerifyCommandSpec {
    if (!existsSync(join(cwd, "Cargo.toml"))) {
        return incomplete(
            requirement,
            "declared cargo test requires Cargo.toml at the repository root",
        )
    }
    const subcommand = parsed.tokens[1]
    if (subcommand === "fmt") {
        const args = parsed.tokens.slice(2)
        if (
            !(
                (args.length === 1 && args[0] === "--check") ||
                (args.length === 2 && args[0] === "--all" && args[1] === "--check")
            )
        ) {
            return incomplete(
                requirement,
                "cargo fmt is limited to 'cargo fmt --check' or 'cargo fmt --all --check'",
            )
        }
        return { label: parsed.normalized, tool: "cargo", args: parsed.tokens.slice(1) }
    }
    if (!/^(build|check|test|clippy)$/.test(subcommand ?? "")) {
        return incomplete(
            requirement,
            "cargo declarations are limited to build, check, test, clippy, and fmt --check",
        )
    }
    const typed = subcommand as "build" | "check" | "test" | "clippy"
    if (!safeCargoArgs(typed, parsed.tokens.slice(2))) {
        return incomplete(
            requirement,
            `cargo ${typed} contains an unsupported flag or argument`,
        )
    }
    const args = canonicalCargoArgs(parsed.tokens.slice(1))
    if (typed === "test" && args.at(-1) === "--") args.pop()
    return {
        label: ["cargo", ...args].join(" "),
        tool: "cargo",
        args,
    }
}

interface ContainedPath {
    readonly path?: string
    readonly reason?: string
}

function containedPath(
    cwd: string,
    candidate: string,
    requireFile: boolean,
): ContainedPath {
    if (
        candidate === "" ||
        candidate.startsWith("-") ||
        candidate.startsWith("@") ||
        isAbsolute(candidate) ||
        /^[A-Za-z]:\//.test(candidate) ||
        hasParentTraversal(candidate)
    ) return { reason: `unsafe or escaping path '${candidate}'` }

    const root = resolve(cwd)
    const absolute = resolve(root, candidate)
    const fromRoot = relative(root, absolute)
    if (escapesRoot(cwd, candidate)) {
        return { reason: `declared node path resolves outside repository: '${candidate}'` }
    }
    if (!existsSync(absolute)) {
        return { reason: `declared node path does not exist: '${candidate}'` }
    }
    try {
        if (requireFile && !statSync(realpathSync(absolute)).isFile()) {
            return { reason: `node --check requires a file: '${candidate}'` }
        }
    } catch (error) {
        return {
            reason: `could not resolve declared node path '${candidate}': ${message(error)}`,
        }
    }
    return { path: (fromRoot || ".").replace(/\\/g, "/") }
}

function translateNode(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
): VerifyCommandSpec {
    // Only the literal two-token pair `--import tsx` is skipped over; any
    // other loader value, path or spelling falls through to the mode gate
    // below and is rejected there.
    const hasTsxLoader =
        parsed.tokens[1] === "--import" && parsed.tokens[2] === "tsx"
    const loaderArgs: readonly string[] = hasTsxLoader ? ["--import", "tsx"] : []
    const rest = parsed.tokens.slice(1 + loaderArgs.length)
    const mode = rest[0]
    // Greenfield allowance: with no package.json there is no manifest to
    // anchor a trusted script, so a bare `node <contained file>` is the
    // same trust class the manifest route grants elsewhere — repo content
    // that just passed review, containment-checked here and revalidated
    // after the merge. Repos WITH a manifest keep the strict rule: declare
    // the script there instead.
    if (
        rest.length === 1 &&
        typeof mode === "string" &&
        !mode.startsWith("-") &&
        !existsSync(join(cwd, "package.json"))
    ) {
        const contained = containedPath(cwd, mode, true)
        if (!contained.path) {
            return incomplete(
                requirement,
                contained.reason ?? `unsafe node path '${mode}'`,
            )
        }
        return {
            label: ["node", ...loaderArgs, contained.path].join(" "),
            tool: "node",
            args: [...loaderArgs, contained.path],
            containedPaths: [{ path: contained.path, requireFile: true }],
        }
    }
    const candidates = rest.slice(1)
    if (
        !/^(--check|--test)$/.test(mode ?? "") ||
        candidates.length === 0 ||
        (mode === "--check" && candidates.length !== 1)
    ) {
        return incomplete(
            requirement,
            "node declarations are limited to '--check <file>' or '--test <contained paths>' (bare 'node <file>' only in repositories without package.json)",
        )
    }
    const paths: string[] = []
    for (const candidate of candidates) {
        const contained = containedPath(cwd, candidate, mode === "--check")
        if (!contained.path) {
            return incomplete(
                requirement,
                contained.reason ?? `unsafe node path '${candidate}'`,
            )
        }
        paths.push(contained.path)
    }
    return {
        label: ["node", ...loaderArgs, mode!, ...paths].join(" "),
        tool: "node",
        args: [...loaderArgs, mode!, ...paths],
        containedPaths: paths.map((path) => ({
            path,
            requireFile: mode === "--check",
        })),
    }
}

// composer.json is read only as an anchor: a declared script must exist in it,
// but nothing about the script body is interpreted here.
function readJsonObject(path: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
        return typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

function translateComposer(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
): VerifyCommandSpec {
    const [, operation, maybeScript, ...remaining] = parsed.tokens
    const script = operation === "run" ? maybeScript : operation
    const rest = operation === "run" ? remaining : parsed.tokens.slice(2)
    if (!script) {
        return incomplete(
            requirement,
            "composer tests must use 'composer <script>' or 'composer run <script>'",
        )
    }
    if (rest.length > 0) {
        return incomplete(
            requirement,
            "composer tests must not pass arguments after the script name",
        )
    }
    if (!SAFE_SCRIPT_NAME.test(script)) {
        return incomplete(requirement, `unsafe composer script name '${script}'`)
    }
    const manifest = readJsonObject(join(cwd, "composer.json"))
    if (!manifest) {
        return incomplete(
            requirement,
            "declared composer test requires a valid root composer.json",
        )
    }
    const scripts = manifest.scripts
    const body = typeof scripts === "object" && scripts !== null
        ? (scripts as Record<string, unknown>)[script]
        : undefined
    // Composer spells a script body as either a string or a list of strings.
    if (
        typeof body !== "string" &&
        !(
            Array.isArray(body) &&
            body.every((entry) => typeof entry === "string")
        )
    ) {
        return incomplete(
            requirement,
            `composer.json does not declare script '${script}'`,
        )
    }
    if (!TRUSTED_COMPOSER_SCRIPTS.has(script)) {
        return incomplete(
            requirement,
            `custom composer script '${script}' is not trusted by the baseline verifier policy`,
        )
    }
    return {
        label: `composer run ${script}`,
        tool: "composer",
        args: ["run", script],
    }
}

function translatePhpunit(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
): VerifyCommandSpec {
    const binary = containedPath(cwd, "vendor/bin/phpunit", true)
    if (!binary.path) {
        return incomplete(
            requirement,
            "declared phpunit test requires a contained vendor/bin/phpunit executable" +
                (binary.reason ? `: ${binary.reason}` : ""),
        )
    }
    const rest = parsed.tokens.slice(1)
    const args: string[] = []
    // Only the binary is emitted absolute (cross-spawn would otherwise
    // resolve it through PATH); path arguments stay repo-relative so a
    // ddev-wrapped argv carries no host prefix into the container. Every
    // path is still recorded absolute for pre-spawn revalidation.
    const containedPaths: VerifyContainedPath[] = [
        { path: join(cwd, binary.path), requireFile: true },
    ]
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index]!
        if (token === "--testsuite") {
            const value = rest[index + 1]
            if (value === undefined || !SAFE_TOKEN.test(value)) {
                return incomplete(
                    requirement,
                    "phpunit --testsuite requires a suite name",
                )
            }
            args.push(token, value)
            index += 1
            continue
        }
        if (token === "-c" || token === "--configuration") {
            const value = rest[index + 1]
            if (value === undefined) {
                return incomplete(
                    requirement,
                    "phpunit -c/--configuration requires a configuration file",
                )
            }
            const contained = containedPath(cwd, value, true)
            if (!contained.path) {
                return incomplete(
                    requirement,
                    contained.reason ?? `unsafe phpunit path '${value}'`,
                )
            }
            args.push(token, contained.path)
            containedPaths.push({
                path: join(cwd, contained.path),
                requireFile: true,
            })
            index += 1
            continue
        }
        if (!token.startsWith("-")) {
            const contained = containedPath(cwd, token, false)
            if (!contained.path) {
                return incomplete(
                    requirement,
                    contained.reason ?? `unsafe phpunit path '${token}'`,
                )
            }
            args.push(contained.path)
            containedPaths.push({
                path: join(cwd, contained.path),
                requireFile: false,
            })
            continue
        }
        return incomplete(
            requirement,
            "phpunit arguments allow only --testsuite <name>, -c/--configuration <file>, and contained test paths",
        )
    }
    // cross-spawn resolves a relative command through which.sync over PATH
    // after only a best-effort process.chdir (skipped in worker threads), so a
    // contained binary must be spawned absolute.
    return {
        label: ["vendor/bin/phpunit", ...rest].join(" "),
        tool: join(cwd, binary.path),
        args,
        containedPaths,
    }
}

function translateDdev(
    cwd: string,
    requirement: DeclaredTestRequirement,
    parsed: DeclaredTokens,
    packageManagers: readonly VerifyJavaScriptPackageManager[],
    insideDdev: boolean,
): VerifyCommandSpec {
    if (insideDdev) {
        return incomplete(
            requirement,
            "ddev exec must not wrap another ddev command",
        )
    }
    if (parsed.tokens[1] !== "exec") {
        return incomplete(requirement, "ddev tests must use 'ddev exec <command>'")
    }
    if (parsed.tokens.length < 3) {
        return incomplete(requirement, "ddev exec requires a command to run")
    }
    if (!existsSync(join(cwd, ".ddev", "config.yaml"))) {
        return incomplete(
            requirement,
            "declared ddev test requires .ddev/config.yaml in the repository root",
        )
    }
    const innerTokens = parsed.tokens.slice(2)
    const inner = dispatchDeclared(
        cwd,
        requirement,
        { normalized: innerTokens.join(" "), tokens: innerTokens },
        packageManagers,
        true,
    )
    // The prefix grants no authority: whatever the dispatcher rejects
    // directly stays rejected with that same reason.
    if (inner.incompleteReason !== undefined) return inner
    // The container sees the declared inner token, not the host-absolute tool
    // the phpunit route resolves for direct spawning.
    return {
        label: parsed.normalized,
        tool: "ddev",
        args: ["exec", innerTokens[0]!, ...inner.args],
        ...(inner.containedPaths
            ? { containedPaths: inner.containedPaths }
            : {}),
    }
}


export function revalidateContainedPaths(
    cwd: string,
    paths: readonly VerifyContainedPath[],
): string | null {
    for (const requirement of paths) {
        // Contained-binary routes spawn absolute (cross-spawn would otherwise
        // resolve a relative command through PATH), so an entry may already be
        // absolute. Re-express it relative to cwd and let the unchanged checks
        // below judge it: anything outside cwd relativises to a traversal and
        // is still rejected, so containment is re-proved, never assumed.
        const candidate = isAbsolute(requirement.path)
            ? relative(resolve(cwd), requirement.path) || "."
            : requirement.path
        if (requirement.allowMissing) {
            if (
                candidate === "" ||
                isAbsolute(candidate) ||
                /^[A-Za-z]:\//.test(candidate) ||
                hasParentTraversal(candidate) ||
                escapesRoot(cwd, candidate)
            ) {
                return (
                    "focused package path failed immediate pre-spawn containment: " +
                    requirement.path
                )
            }
            continue
        }
        const result = containedPath(cwd, candidate, requirement.requireFile)
        if (!result.path) {
            return (
                "declared node path failed immediate pre-spawn containment: " +
                (result.reason ?? requirement.path)
            )
        }
    }
    return null
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
