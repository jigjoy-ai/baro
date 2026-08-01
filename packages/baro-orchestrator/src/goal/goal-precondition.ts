/**
 * Constraints the repository already contradicts, found before any model runs.
 *
 * Measured: a goal said "no file under src/ imports class-validator" and also
 * "do not modify any *.spec.ts". Twenty-one spec files under src/ import
 * class-validator, so the two could not both hold. The Architect noticed on
 * one run and did not on the next, with the same goal and the same repository,
 * and the run that missed it spent an hour producing work built on a
 * contradiction. A check that depends on a model being in the mood is not a
 * check.
 *
 * The host cannot read English, so it does not try. It evaluates predicates
 * the Architect states — "this text must not appear under this path", "these
 * files must not change" — and reports a conflict only when it can name the
 * exact files that prove it. A finding here is evidence a person can verify,
 * never an inference.
 *
 * An earlier version read the constraint text with regular expressions. It fit
 * the one goal it was written against: a Go import looked like a path, a
 * package without a hyphen was invisible, and "do not modify any *_test.go"
 * froze every Go file in the tree. That is why the predicate is stated by the
 * stage that actually reads the repository, and never inferred here.
 */

export interface AbsentPredicate {
    readonly kind: "absent"
    /** Constraint this came from, so a report can point back at it. */
    readonly invariantId: string
    /** Repository-relative prefix the constraint covers, e.g. "src/". */
    readonly pathPrefix: string
    /** Text that must not appear in any covered file, e.g. "class-validator". */
    readonly text: string
}

export interface UnchangedPredicate {
    readonly kind: "unchanged"
    readonly invariantId: string
    /** Suffix of the protected files, e.g. ".spec.ts". */
    readonly pathSuffix: string
}

export type GoalPredicate = AbsentPredicate | UnchangedPredicate

export interface RepositoryFile {
    /** Repository-relative path. */
    readonly path: string
    readonly text: string
}

export interface GoalPreconditionConflict {
    readonly absentInvariantId: string
    readonly unchangedInvariantId: string
    readonly files: readonly string[]
    readonly text: string
}

/**
 * A conflict exists when removing forbidden text would require editing files
 * another constraint freezes. Files that merely contain the text are not a
 * conflict — that is the migration. Files that contain it *and* cannot be
 * touched are the contradiction.
 */
export function goalPreconditionConflicts(
    predicates: readonly GoalPredicate[],
    files: readonly RepositoryFile[],
): GoalPreconditionConflict[] {
    const absent = predicates.filter(
        (predicate): predicate is AbsentPredicate => predicate.kind === "absent",
    )
    const unchanged = predicates.filter(
        (predicate): predicate is UnchangedPredicate =>
            predicate.kind === "unchanged",
    )
    if (absent.length === 0 || unchanged.length === 0) return []

    const conflicts: GoalPreconditionConflict[] = []
    for (const forbidden of absent) {
        const violating = files.filter(
            (file) =>
                file.path.startsWith(forbidden.pathPrefix) &&
                file.text.includes(forbidden.text),
        )
        if (violating.length === 0) continue
        for (const frozen of unchanged) {
            const trapped = violating
                .filter((file) => file.path.endsWith(frozen.pathSuffix))
                .map((file) => file.path)
                .sort()
            if (trapped.length === 0) continue
            conflicts.push({
                absentInvariantId: forbidden.invariantId,
                unchangedInvariantId: frozen.invariantId,
                files: trapped,
                text: forbidden.text,
            })
        }
    }
    return conflicts
}

const MAX_LISTED_FILES = 8

/** What a person needs to decide, with the files that prove it. */
export function renderGoalPreconditionConflict(
    conflict: GoalPreconditionConflict,
): string {
    const lines = [
        `[baro] ${conflict.absentInvariantId} and ${conflict.unchangedInvariantId} cannot both hold.`,
        "",
        `${conflict.absentInvariantId} forbids "${conflict.text}".`,
        `${conflict.unchangedInvariantId} forbids changing these ${conflict.files.length} file(s), and every one of them contains it:`,
    ]
    for (const path of conflict.files.slice(0, MAX_LISTED_FILES)) {
        lines.push(`  ${path}`)
    }
    if (conflict.files.length > MAX_LISTED_FILES) {
        lines.push(`  … and ${conflict.files.length - MAX_LISTED_FILES} more`)
    }
    lines.push(
        "",
        "Decide which constraint gives way before any work starts. Nothing here",
        "is a judgement about the goal — only that these two sentences describe",
        "a repository that cannot exist.",
    )
    return lines.join("\n")
}
