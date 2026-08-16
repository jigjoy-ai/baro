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
