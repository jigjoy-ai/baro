import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    ALL_GATES,
    BASE_GATES,
    SPAWN_GATES,
    announceGates,
} from "../../src/execution/gate-registry.js"
import { buildDefaultStoryPrompt } from "../../src/prd.js"

const ROOT = join(import.meta.dirname, "..", "..")

describe("gate registry — enforced means announced", () => {
    it("every gate announces itself, carries its marker, and names a real enforcer", () => {
        for (const gate of ALL_GATES) {
            const text = gate.announce({
                surface: {
                    writes: ["src/a.ts"],
                    ownedElsewhere: { "src/b.ts": "S2" },
                },
                hostRunsWholeTreeVerification: true,
            })
            assert.ok(text, `${gate.id} announces under an active context`)
            assert.ok(
                text!.includes(`[gate:${gate.id}]`),
                `${gate.id} carries its own marker, so a reader can join rule to gate`,
            )
            assert.ok(gate.summary.length > 0, `${gate.id} has a summary`)
            assert.ok(
                existsSync(join(ROOT, gate.enforcedBy)),
                `${gate.id} names an enforcement module that exists: ${gate.enforcedBy}`,
            )
        }
    })

    it("the base story prompt contains every base gate's rule", () => {
        const prompt = buildDefaultStoryPrompt({
            id: "S1",
            title: "t",
            description: "d",
            acceptance: [],
            tests: [],
            dependsOn: [],
            priority: 1,
        } as never)
        for (const gate of BASE_GATES) {
            assert.ok(
                prompt.includes(`[gate:${gate.id}]`),
                `base prompt announces ${gate.id}`,
            )
        }
    })

    it("a spawn gate stays silent without its context instead of announcing a wrong rule", () => {
        assert.deepEqual(announceGates(SPAWN_GATES, {}), [])
        const announced = announceGates(SPAWN_GATES, {
            surface: { writes: ["src/a.ts"], ownedElsewhere: {} },
        })
        assert.equal(announced.length, 1)
        assert.ok(announced[0]!.includes("[gate:write-surface]"))
    })

    it("scopes story verification to its perimeter only when the run gate exists", () => {
        // Without a run-level verifier the story's suite duty stays whole —
        // announcing a narrower duty would be a rule nobody enforces.
        const silent = announceGates(SPAWN_GATES, {
            surface: { writes: ["src/a.ts"], ownedElsewhere: {} },
            hostRunsWholeTreeVerification: false,
        })
        assert.equal(silent.some((t) => t.includes("run-verification")), false)
        const announced = announceGates(SPAWN_GATES, {
            hostRunsWholeTreeVerification: true,
        })
        assert.equal(announced.length, 1)
        assert.ok(announced[0]!.includes("[gate:run-verification]"))
        assert.match(announced[0]!, /Do NOT run the repository's full test suites/)
    })

    it("the advisory altitude rule is disclosed to every story, and fails none", () => {
        const altitude = BASE_GATES.filter((gate) => gate.id === "altitude")
        assert.equal(altitude.length, 1, "altitude is registered once, in BASE_GATES")
        assert.deepEqual(
            BASE_GATES.map((gate) => gate.id),
            ["evidence-capture", "build-before-commit", "altitude"],
        )
        // The rule needs no spawn context, so SPAWN_GATES must not carry it —
        // and ALL_GATES stays the plain concatenation it already was.
        assert.deepEqual(
            SPAWN_GATES.map((gate) => gate.id),
            ["write-surface", "run-verification"],
        )
        assert.deepEqual(
            ALL_GATES.map((gate) => gate.id),
            [...BASE_GATES, ...SPAWN_GATES].map((gate) => gate.id),
        )

        const gate = altitude[0]!
        assert.equal(gate.enforcedBy, "src/acceptance/altitude.ts")
        assert.ok(
            existsSync(join(ROOT, gate.enforcedBy)),
            `altitude names an enforcement module that exists: ${gate.enforcedBy}`,
        )
        assert.ok(gate.summary.trim().length > 0, "altitude has a summary")

        const text = gate.announce({
            surface: {
                writes: ["src/a.ts"],
                ownedElsewhere: { "src/b.ts": "S2" },
            },
            hostRunsWholeTreeVerification: true,
        })
        assert.ok(text, "altitude announces under the maximal context")
        assert.ok(text!.includes("[gate:altitude]"))
        assert.ok(text!.includes("1500"), "the size threshold is stated as a number")
        assert.ok(text!.includes("80"), "the growth threshold is stated as a number")
        assert.match(
            text!,
            /never fails a criterion, never blocks completion/,
            "an advisory measurement must say it cannot be failed",
        )
        assert.match(
            text!,
            /Explicit extraction instructions in the goal or decision document outrank that default/,
            "an explicit instruction to split outranks do-not-refactor discipline",
        )
    })

    it("the default story prompt carries the altitude thresholds, not just its marker", () => {
        // prd.ts projects BASE_GATES verbatim; registering the gate is the
        // whole change — the numbers must arrive at the story unedited.
        const prompt = buildDefaultStoryPrompt({
            id: "S1",
            title: "t",
            description: "d",
            acceptance: [],
            tests: [],
            dependsOn: [],
            priority: 1,
        } as never)
        assert.ok(prompt.includes("[gate:altitude]"))
        assert.ok(prompt.includes("1500"))
        assert.ok(prompt.includes("80"))
    })

    it("the projections cannot be quietly reverted to hand-written text", () => {
        // The v0.88 dispatcher pattern: read the source, refuse inherited
        // silence. Both prompt builders must draw from the registry.
        const prd = readFileSync(join(ROOT, "src/prd.ts"), "utf8")
        assert.ok(
            prd.includes("announceGates(BASE_GATES"),
            "prd.ts projects base gates from the registry",
        )
        const factory = readFileSync(
            join(ROOT, "src/market/story-factory.ts"),
            "utf8",
        )
        assert.ok(
            factory.includes("announceGates(SPAWN_GATES"),
            "story-factory projects spawn gates from the registry",
        )
    })
})
