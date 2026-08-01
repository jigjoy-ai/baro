/**
 * Runs the precondition check against the working tree, once, at run start.
 *
 * It reports and does not stop the run. What it finds is real — it names the
 * files that prove it — but a goal that cannot be satisfied is still the
 * operator's call, not the host's, and a check that refuses work has to be
 * right every time before it earns that. Being told on every run beats being
 * told when a model happens to notice, which is what this replaces.
 */

import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

import {
    goalPredicatesFromWire,
    parseGoalConstraintContract,
} from "./goal-constraint-appendix.js"
import {
    type RepositoryFile,
    goalPreconditionConflicts,
    renderGoalPreconditionConflict,
} from "./goal-precondition.js"

export interface GoalPreconditionScanOptions {
    readonly cwd: string
    /** Repository-relative paths to inspect, usually a git listing. */
    readonly files: readonly string[]
    /** Skip anything larger; a constraint names a module, not a bundle. */
    readonly maxFileBytes?: number
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024

/**
 * @param decisionDocument the Architect's document, which carries the
 * predicates it stated for this repository. A document without them means no
 * constraint was expressible, not that none was violated.
 */
export function reportGoalPreconditions(
    decisionDocument: string | null | undefined,
    options: GoalPreconditionScanOptions,
    write: (line: string) => void,
): number {
    const predicates = goalPredicatesFromWire(
        parseGoalConstraintContract(decisionDocument),
    )
    if (predicates.length === 0) return 0

    const conflicts = goalPreconditionConflicts(predicates, readFiles(options))
    for (const conflict of conflicts) {
        write(renderGoalPreconditionConflict(conflict))
    }
    return conflicts.length
}

function readFiles(options: GoalPreconditionScanOptions): RepositoryFile[] {
    const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    const files: RepositoryFile[] = []
    for (const path of options.files) {
        const absolute = resolve(options.cwd, path)
        // Never follow a listing outside the tree it describes.
        if (relative(options.cwd, absolute).startsWith("..")) continue
        let text: string
        try {
            text = readFileSync(absolute, "utf8")
        } catch {
            continue
        }
        if (text.length > maxBytes) continue
        files.push({ path, text })
    }
    return files
}
