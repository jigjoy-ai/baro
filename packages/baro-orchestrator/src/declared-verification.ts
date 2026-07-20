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
const SAFE_TOKEN = /^[A-Za-z0-9_./:@+=,-]+$/
const SAFE_CARGO_VALUE = /^[A-Za-z0-9_+.-]+(?:,[A-Za-z0-9_+.-]+)*$/
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

interface PackageManifest {
    scripts?: Record<string, unknown>
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
        return incomplete(
            requirement,
            "unsupported declared test; allowed tools are npm/pnpm/yarn, exact npx rstest run paths, cargo, node, and git diff --check",
        )
    })
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
    if (/[^A-Za-z0-9_./:@+=,\-\s]/.test(normalized)) {
        return "declared test contains unsupported quoting, shell, or glob syntax"
    }
    if (/[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
        return "declared test contains control characters"
    }
    const tokens = normalized.split(/\s+/)
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
    const rest = operation === "test" ? parsed.tokens.slice(2) : remaining
    if (!script) {
        return incomplete(
            requirement,
            "package tests must use '<manager> test' or '<manager> run <script>'",
        )
    }
    if (!SAFE_SCRIPT_NAME.test(script)) {
        return incomplete(requirement, `unsafe package script name '${script}'`)
    }

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

    const manifestPath = join(cwd, "package.json")
    const manifest = existsSync(manifestPath) ? readManifest(manifestPath) : null
    if (!manifest) {
        return incomplete(
            requirement,
            "declared package test requires a valid root package.json",
        )
    }
    if (typeof manifest.scripts?.[script] !== "string") {
        return incomplete(
            requirement,
            `package.json does not declare script '${script}'`,
        )
    }
    if (!TRUSTED_PACKAGE_SCRIPTS.has(script)) {
        return incomplete(
            requirement,
            `custom package script '${script}' is not trusted by the baseline verifier policy`,
        )
    }
    const authority = managers.find((manager) => manager.cwd === undefined)
    if (!authority) {
        return incomplete(
            requirement,
            "root package-manager authority could not be resolved safely",
        )
    }
    const containedPaths = focusedArgs.map(focusedPathRequirement)
    return {
        label: [authority.manager, "run", script, ...trailingArgs].join(" "),
        ...packageCommand(authority, script, trailingArgs),
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
    const mode = parsed.tokens[1]
    const candidates = parsed.tokens.slice(2)
    if (
        !/^(--check|--test)$/.test(mode ?? "") ||
        candidates.length === 0 ||
        (mode === "--check" && candidates.length !== 1)
    ) {
        return incomplete(
            requirement,
            "node declarations are limited to '--check <file>' or '--test <contained paths>'",
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
        label: ["node", mode!, ...paths].join(" "),
        tool: "node",
        args: [mode!, ...paths],
        containedPaths: paths.map((path) => ({
            path,
            requireFile: mode === "--check",
        })),
    }
}

export function revalidateContainedPaths(
    cwd: string,
    paths: readonly VerifyContainedPath[],
): string | null {
    for (const requirement of paths) {
        if (requirement.allowMissing) {
            if (
                requirement.path === "" ||
                isAbsolute(requirement.path) ||
                /^[A-Za-z]:\//.test(requirement.path) ||
                hasParentTraversal(requirement.path) ||
                escapesRoot(cwd, requirement.path)
            ) {
                return (
                    "focused package path failed immediate pre-spawn containment: " +
                    requirement.path
                )
            }
            continue
        }
        const result = containedPath(
            cwd,
            requirement.path,
            requirement.requireFile,
        )
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
