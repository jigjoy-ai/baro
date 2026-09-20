/**
 * Sole owner of declared-requirement crediting.
 *
 * "Incomplete" is reserved for a declared requirement that nothing executed.
 * A requirement whose file a green command in this same verification already
 * ran is credited instead, so a refused translation stops being reported as
 * unverified work.
 */

import type {
    DeclaredTestRequirement,
    VerifyCommandResult,
} from "./verify.js"

export interface CreditedRequirement {
    file: string
    creditedBy: string
}

// Matching runs on the command label because that is the only identity a
// VerifyCommandResult carries, and a label is built as `[tool, ...args]`.
const MANAGER_SUITE =
    /^(?:npm|pnpm|yarn|corepack(?: yarn)?) run [A-Za-z0-9_.:-]+(?: \((.+)\))?$/
const NODE_SCRIPT_SUITE = /^node --test \(.+\)$/
const PATH_TOKEN = /^[A-Za-z0-9_@.][A-Za-z0-9_./@-]*$/

function normalizePath(value: string): string {
    const unquoted = value.replace(/^["']|["']$/g, "")
    return unquoted.replace(/^\.\//, "").replace(/\/+$/, "")
}

/** Repo-relative paths a declared command names, in declaration order. */
export function declaredRequirementFiles(
    requirement: DeclaredTestRequirement,
): readonly string[] {
    if (typeof requirement.command !== "string") return []
    const files: string[] = []
    for (const token of requirement.command.trim().split(/\s+/).slice(1)) {
        if (token.startsWith("-")) continue
        const candidate = normalizePath(token)
        if (candidate === "" || !PATH_TOKEN.test(candidate)) continue
        if (!candidate.includes("/") && !/\.[A-Za-z0-9]+$/.test(candidate)) {
            continue
        }
        if (!files.includes(candidate)) files.push(candidate)
    }
    return files
}

/** The directory a whole-suite command covers, or null when it is focused. */
function suiteScope(label: string): string | null {
    const manager = MANAGER_SUITE.exec(label)
    if (manager) return manager[1] ? normalizePath(manager[1]) : "."
    return NODE_SCRIPT_SUITE.test(label) ? "." : null
}

function covers(scope: string, file: string): boolean {
    return scope === "." || file === scope || file.startsWith(`${scope}/`)
}

function creditFor(
    file: string,
    passed: readonly VerifyCommandResult[],
): string | null {
    for (const command of passed) {
        const tokens = command.command.trim().split(/\s+/)
        if (tokens.some((token) => normalizePath(token) === file)) {
            return command.command
        }
    }
    for (const command of passed) {
        const scope = suiteScope(command.command)
        if (scope !== null && covers(scope, file)) return command.command
    }
    return null
}

export function creditDeclaredRequirements(
    requirements: readonly DeclaredTestRequirement[],
    executed: readonly VerifyCommandResult[],
): {
    credited: readonly CreditedRequirement[]
    uncovered: readonly DeclaredTestRequirement[]
} {
    const passed = executed.filter((command) => command.status === "passed")
    const credited: CreditedRequirement[] = []
    const uncovered: DeclaredTestRequirement[] = []
    for (const requirement of requirements) {
        const files = declaredRequirementFiles(requirement)
        if (files.length === 0) {
            uncovered.push(requirement)
            continue
        }
        const creditedBy = files.map((file) => creditFor(file, passed))
        if (creditedBy.some((by) => by === null)) {
            uncovered.push(requirement)
            continue
        }
        files.forEach((file, index) => {
            credited.push({ file, creditedBy: creditedBy[index]! })
        })
    }
    return { credited, uncovered }
}
