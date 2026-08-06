import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

/**
 * The phase's SHAPE is decided before its backend.
 *
 * This is a source-order invariant, and it is here because breaking it costs a
 * run rather than a test: the Architect's Claude-only gate was removed, every
 * lane became able to hold the session — and a `--llm openai` run still got the
 * single-call Architect, because a per-backend branch sat above the bus check
 * and returned first. Nothing failed; the phase was quietly the old shape.
 *
 * Reading the file is the honest way to assert it. The dispatcher's branches
 * all return, so no behavioural test distinguishes "the bus was not enabled"
 * from "the bus was never reached".
 */
describe("the Architect's shape is decided before its backend", () => {
    const file = readFileSync(
        join(import.meta.dirname, "../scripts/run-architect.ts"),
        "utf8",
    )

    /**
     * Only the dispatcher's own body. Backend checks appear elsewhere in this
     * file for unrelated reasons — resolving a model name, for one — and a
     * whole-file search would match those and mean nothing.
     */
    const dispatcher = (() => {
        const start = file.indexOf("async function runInitialArchitect(")
        assert.ok(start > 0, "the dispatcher must still be named runInitialArchitect")
        const next = file.indexOf("\nasync function ", start + 1)
        return file.slice(start, next > 0 ? next : undefined)
    })()

    const source = dispatcher
    const busCheck = source.indexOf("if (architectBusEnabled(args))")

    it("checks for the bus at all", () => {
        assert.ok(busCheck > 0, "the dispatcher must consult architectBusEnabled")
    })

    it("reaches that check before any per-backend branch", () => {
        const backendBranches = [
            'if (args.llm === "openai")',
            'if (args.llm === "codex")',
            'if (args.llm === "opencode")',
            'if (args.llm === "pi")',
        ]
        for (const branch of backendBranches) {
            const at = source.indexOf(branch)
            if (at < 0) continue
            assert.ok(
                busCheck < at,
                `${branch} is reached before the bus check, so a run on that ` +
                    `backend silently gets the single-call Architect`,
            )
        }
    })

    it("does not gate the bus on one backend", () => {
        const at = file.indexOf("function architectBusEnabled")
        const gate = file.slice(at, at + 400)
        assert.match(gate, /BARO_ARCHITECT_BUS/u)
        assert.doesNotMatch(
            gate,
            /args\.llm\s*===/u,
            "whether a phase is a conversation is not a property of the backend",
        )
    })
})
