import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { NamedTimers } from "../../src/runtime/named-timers.js"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe("NamedTimers", () => {
    it("keeps exactly one pending timer per name and re-arms on demand", async () => {
        const timers = new NamedTimers<"a" | "b">()
        const fired: string[] = []
        timers.arm("a", 0, () => fired.push("a-first"))
        timers.arm("a", 0, () => fired.push("a-second"))
        timers.arm("b", 0, () => fired.push("b"))
        assert.equal(timers.isArmed("a"), true)
        await tick()
        assert.deepEqual(fired.sort(), ["a-second", "b"])
        assert.equal(timers.isArmed("a"), false)
    })

    it("lets a callback re-arm its own name (split-deadline pattern)", async () => {
        const timers = new NamedTimers<"deadline">()
        let rounds = 0
        timers.arm("deadline", 0, function fire() {
            rounds += 1
            if (rounds < 3) timers.arm("deadline", 0, fire)
        })
        await tick()
        await tick()
        assert.equal(rounds, 3)
        assert.equal(timers.isArmed("deadline"), false)
    })

    it("clear and clearAll cancel without firing", async () => {
        const timers = new NamedTimers<"x" | "y" | "z">()
        const fired: string[] = []
        timers.arm("x", 0, () => fired.push("x"))
        timers.arm("y", 0, () => fired.push("y"))
        timers.arm("z", 0, () => fired.push("z"))
        timers.clear("x")
        timers.clearAll()
        assert.equal(timers.isArmed("y"), false)
        await tick()
        assert.deepEqual(fired, [])
        // Clearing an unarmed name is a safe no-op.
        timers.clear("x")
    })
})
