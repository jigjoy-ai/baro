/**
 * Every gate a PrdStory crosses keeps its own hand-written field list, and
 * seven of them silently shed `writes` before anyone noticed — one lost run
 * per boundary. This test walks the known gates (TypeScript AND Rust) and
 * requires each to name every planner-authored field, so the ninth boundary
 * fails here, by file name, instead of in a live run.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    PLANNER_AUTHORED_STORY_FIELDS,
    PRD_STORY_FIELDS,
} from "../../src/prd.js"

const ORCHESTRATOR_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const REPO_ROOT = join(ORCHESTRATOR_ROOT, "../..")

/** Gates that must understand everything a planner may author. */
const PLANNER_FIELD_GATES = [
    "src/prd.ts",
    "src/runtime/runtime-replan.ts",
    "src/runtime-graph/legacy-replan.ts",
    "src/planning/adapters/planner-openai-progressive.ts",
    "src/planning/domain/progressive-plan.ts",
].map((relative) => join(ORCHESTRATOR_ROOT, relative))

/** The Rust host's serde gate (deny-unknown lives on the other side too). */
const RUST_STORY_GATE = join(REPO_ROOT, "crates/baro-tui/src/executor.rs")

function fieldsMissingFrom(
    source: string,
    fields: readonly string[],
): string[] {
    return fields.filter((field) => !source.includes(field))
}

describe("PrdStory boundary conformance", () => {
    it("every TypeScript gate names every planner-authored field", () => {
        const failures: string[] = []
        for (const path of PLANNER_FIELD_GATES) {
            const source = readFileSync(path, "utf8")
            const missing = fieldsMissingFrom(
                source,
                PLANNER_AUTHORED_STORY_FIELDS,
            )
            if (missing.length > 0) {
                failures.push(`${path}: missing ${missing.join(", ")}`)
            }
        }
        assert.deepEqual(
            failures,
            [],
            `a story field is unknown to a gate it must cross:\n${failures.join("\n")}`,
        )
    })

    it("the Rust serde gate names every planner-authored field", () => {
        const source = readFileSync(RUST_STORY_GATE, "utf8")
        // serde renames are camelCase strings; snake_case idents cover the rest.
        const snake = (field: string) =>
            field.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`)
        const missing = PLANNER_AUTHORED_STORY_FIELDS.filter(
            (field) =>
                !source.includes(field) && !source.includes(snake(field)),
        )
        assert.deepEqual(
            missing,
            [],
            `crates/baro-tui/src/executor.rs does not know: ${missing.join(", ")}`,
        )
    })

    it("the runtime constants stay in lockstep", () => {
        for (const field of PLANNER_AUTHORED_STORY_FIELDS) {
            assert.ok(
                (PRD_STORY_FIELDS as readonly string[]).includes(field),
                `planner-authored field '${field}' missing from PRD_STORY_FIELDS`,
            )
        }
    })
})
