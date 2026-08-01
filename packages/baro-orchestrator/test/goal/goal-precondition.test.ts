import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    type GoalPredicate,
    type RepositoryFile,
    goalPreconditionConflicts,
    renderGoalPreconditionConflict,
} from "../../src/goal/goal-precondition.js"

const FORBID_CV: GoalPredicate = {
    kind: "absent",
    invariantId: "G-C1",
    pathPrefix: "src/",
    text: "class-validator",
}
const FREEZE_SPECS: GoalPredicate = {
    kind: "unchanged",
    invariantId: "G-C2",
    pathSuffix: ".spec.ts",
}

function file(path: string, text = ""): RepositoryFile {
    return { path, text }
}

describe("constraints the repository already contradicts", () => {
    // The measured goal: "no file under src/ imports class-validator" together
    // with "do not modify any *.spec.ts", in a repository where 21 spec files
    // import it. The Architect caught this on one run and missed it on the
    // next, same goal, same checkout.
    it("names the files that prove two constraints cannot both hold", () => {
        const conflicts = goalPreconditionConflicts(
            [FORBID_CV, FREEZE_SPECS],
            [
                file("src/shops/dtos/createShop.dto.ts", "import { IsString } from 'class-validator'"),
                file("src/shops/dtos/__tests__/createShop.spec.ts", "import { validateSync } from 'class-validator'"),
                file("src/common/shared/__tests__/pagination.spec.ts", "import { plainToInstance } from 'class-transformer'\nimport { validateSync } from 'class-validator'"),
                file("src/menus/menu.service.ts", "no imports here"),
            ],
        )
        assert.equal(conflicts.length, 1)
        assert.deepEqual(conflicts[0]!.files, [
            "src/common/shared/__tests__/pagination.spec.ts",
            "src/shops/dtos/__tests__/createShop.spec.ts",
        ])
        assert.equal(conflicts[0]!.absentInvariantId, "G-C1")
        assert.equal(conflicts[0]!.unchangedInvariantId, "G-C2")
    })

    // A DTO that imports the library is the work, not a contradiction.
    it("says nothing about files the goal is free to change", () => {
        const conflicts = goalPreconditionConflicts(
            [FORBID_CV, FREEZE_SPECS],
            [
                file("src/shops/dtos/createShop.dto.ts", "import 'class-validator'"),
                file("src/menus/dtos/createMenu.dto.ts", "import 'class-validator'"),
            ],
        )
        assert.deepEqual(conflicts, [])
    })

    it("says nothing when the forbidden text is not there at all", () => {
        const conflicts = goalPreconditionConflicts(
            [FORBID_CV, FREEZE_SPECS],
            [file("src/a.spec.ts", "import { z } from 'zod'")],
        )
        assert.deepEqual(conflicts, [])
    })

    it("respects the path a constraint actually covers", () => {
        const conflicts = goalPreconditionConflicts(
            [FORBID_CV, FREEZE_SPECS],
            [file("test/legacy/old.spec.ts", "import 'class-validator'")],
        )
        assert.deepEqual(conflicts, [], "the constraint named src/, not test/")
    })

    it("needs both kinds of predicate before it can say anything", () => {
        const violating = [file("src/a.spec.ts", "import 'class-validator'")]
        assert.deepEqual(goalPreconditionConflicts([FORBID_CV], violating), [])
        assert.deepEqual(goalPreconditionConflicts([FREEZE_SPECS], violating), [])
    })

    it("reports evidence a person can check, not a judgement", () => {
        const [conflict] = goalPreconditionConflicts(
            [FORBID_CV, FREEZE_SPECS],
            [file("src/a.spec.ts", "import 'class-validator'")],
        )
        assert.ok(conflict)
        const text = renderGoalPreconditionConflict(conflict)
        assert.match(text, /G-C1 and G-C2 cannot both hold/u)
        assert.match(text, /src\/a\.spec\.ts/u)
        assert.doesNotMatch(
            text,
            /should|better|recommend/iu,
            "which constraint gives way is not the host's call",
        )
    })

    it("bounds a long list without hiding how long it is", () => {
        const files = Array.from({ length: 21 }, (_, index) =>
            file(`src/pkg/f${String(index).padStart(2, "0")}.spec.ts`, "class-validator"),
        )
        const [conflict] = goalPreconditionConflicts([FORBID_CV, FREEZE_SPECS], files)
        assert.ok(conflict)
        assert.equal(conflict.files.length, 21)
        assert.match(renderGoalPreconditionConflict(conflict), /and 13 more/u)
    })
})
