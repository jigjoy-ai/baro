/**
 * Signals that say whether a verification failure is the harness's fault or
 * the patch's.
 *
 * `match` is a case-insensitive literal substring, never a regex, so the table
 * stays inert data an operator can extend. Array order IS precedence: a tsc
 * line like `error TS2307: Cannot find module 'x'` matches both an environment
 * and a regression signal, and environment must win. A frozen TS constant, not
 * a .json — tsc and tsup copy no assets, so data beside src never reaches dist.
 */

import { readFileSync, statSync } from "node:fs"

export type FailureBucket = "environment" | "time-ceiling" | "regression"

export type FailureRemedy =
    | "rematerialize-worktree"
    | "install-dependencies"
    | "lift-ceiling"
    | "none"

export interface FailureSignal {
    id: string
    bucket: FailureBucket
    remedy: FailureRemedy
    /** Case-insensitive literal substring; never interpreted as a pattern. */
    match: string
}

const BUCKETS: ReadonlySet<string> = new Set<FailureBucket>([
    "environment",
    "time-ceiling",
    "regression",
])

const REMEDIES: ReadonlySet<string> = new Set<FailureRemedy>([
    "rematerialize-worktree",
    "install-dependencies",
    "lift-ceiling",
    "none",
])

/** An override file past this size is ignored rather than read into memory. */
const MAX_SIGNALS_FILE_BYTES = 64 * 1024

export const FAILURE_SIGNALS: readonly FailureSignal[] = Object.freeze([
    // Environment: the tree or the toolchain is wrong, so a retry can help.
    {
        id: "verification-cwd-missing",
        bucket: "environment",
        remedy: "rematerialize-worktree",
        match: "verification cwd missing",
    },
    {
        id: "enoent",
        bucket: "environment",
        remedy: "rematerialize-worktree",
        match: "ENOENT",
    },
    {
        id: "cargo-manifest-missing",
        bucket: "environment",
        remedy: "rematerialize-worktree",
        match: "could not find Cargo.toml",
    },
    {
        id: "node-types-missing",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "@types/node",
    },
    {
        id: "node-module-missing",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "Cannot find module",
    },
    {
        id: "node-esm-module-missing",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "ERR_MODULE_NOT_FOUND",
    },
    {
        id: "command-not-found",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "command not found",
    },
    {
        id: "python-module-missing",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "ModuleNotFoundError",
    },
    {
        id: "go-package-missing",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "cannot find package",
    },
    {
        id: "php-class-missing",
        bucket: "environment",
        remedy: "install-dependencies",
        match: "Class not found",
    },

    {
        id: "absolute-command-ceiling",
        bucket: "time-ceiling",
        remedy: "lift-ceiling",
        match: "exceeded the absolute command ceiling",
    },

    // Regression: re-running cannot change the verdict; the tail is the story's.
    {
        id: "assertion-failed",
        bucket: "regression",
        remedy: "none",
        match: "AssertionError",
    },
    {
        id: "typescript-error",
        bucket: "regression",
        remedy: "none",
        match: "error TS",
    },
    {
        id: "unused-warning",
        bucket: "regression",
        remedy: "none",
        match: "warning: unused",
    },
    {
        id: "warnings-denied",
        bucket: "regression",
        remedy: "none",
        match: "warnings are denied",
    },
])

/**
 * Built-in table, optionally prefixed with entries from the JSON file named by
 * BARO_FAILURE_SIGNALS_FILE. Operator entries are prepended so they win the
 * first match. Any defect in the override — unreadable, oversized, not an
 * array of well-formed signals — yields the built-in table; this never throws,
 * because a malformed operator file must not fail a verification.
 */
export function loadFailureSignals(): readonly FailureSignal[] {
    const path = process.env.BARO_FAILURE_SIGNALS_FILE
    if (!path) return FAILURE_SIGNALS
    try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > MAX_SIGNALS_FILE_BYTES) {
            return FAILURE_SIGNALS
        }
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
        if (!Array.isArray(parsed)) return FAILURE_SIGNALS
        const overrides: FailureSignal[] = []
        for (const entry of parsed) {
            if (!isFailureSignal(entry)) return FAILURE_SIGNALS
            overrides.push({
                id: entry.id,
                bucket: entry.bucket,
                remedy: entry.remedy,
                match: entry.match,
            })
        }
        return [...overrides, ...FAILURE_SIGNALS]
    } catch {
        return FAILURE_SIGNALS
    }
}

function isFailureSignal(value: unknown): value is FailureSignal {
    if (typeof value !== "object" || value === null) return false
    const candidate = value as Record<string, unknown>
    return (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        typeof candidate.match === "string" &&
        candidate.match.length > 0 &&
        typeof candidate.bucket === "string" &&
        BUCKETS.has(candidate.bucket) &&
        typeof candidate.remedy === "string" &&
        REMEDIES.has(candidate.remedy)
    )
}
