import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { RunRegistry, type RunRecord } from "../../src/operator/run-registry.js"

/* A fake `baro` that speaks protocol v3 on stdout: the registry only ever
   reads the stream, so this covers spawning, folding and queuing without a
   model or a repository. The goal text selects the script's behaviour. */

let dir: string
let fakeBaro: string

before(() => {
    dir = mkdtempSync(join(tmpdir(), "baro-operator-registry-"))
    fakeBaro = join(dir, "fake-baro.js")
    writeFileSync(
        fakeBaro,
        `#!/usr/bin/env node
const goal = process.argv[2] ?? ""
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
const ms = goal.startsWith("slow") ? 400 : 20
say({ type: "architect_start" })
setTimeout(() => {
  say({ type: "init", protocol: 3, project: "fake", stories: [{ id: "S1" }] })
  say({ type: "story_merged", id: "S1", ts: "2026-09-10T10:00:00.000Z" })
  if (goal.includes("fail")) {
    process.stderr.write("boom\\n")
    say({ type: "done", success: false, abort_code: "shell_timeout", abort_reason: "S1 timed out" })
    process.exit(1)
  }
  say({ type: "done", success: true, stats: { stories_completed: 1, stories_skipped: 0 } })
  process.exit(0)
}, ms)
`,
    )
    chmodSync(fakeBaro, 0o755)
})

after(() => {
    rmSync(dir, { recursive: true, force: true })
})

function finished(registry: RunRegistry, id: string): Promise<RunRecord> {
    return new Promise((resolve) => {
        const tick = setInterval(() => {
            const run = registry.get(id)
            if (run?.finishedAt !== null) {
                clearInterval(tick)
                resolve(run!)
            }
        }, 10)
    })
}

describe("operator run registry", () => {
    it("spawns baro headless, folds milestones and reports the outcome", async () => {
        const milestones: string[] = []
        const outcomes: string[] = []
        const registry = new RunRegistry({
            baroBin: fakeBaro,
            baroArgs: ["--local-only"],
            onMilestone: (_run, line) => milestones.push(line),
            onFinished: (_run, outcome) => outcomes.push(outcome),
        })
        const { run, behind } = registry.delegate("quick goal", dir)
        assert.equal(behind, null)
        assert.equal(registry.stateOf(run), "running")
        const done = await finished(registry, run.id)
        assert.equal(done.terminal, "completed")
        assert.equal(done.exitCode, 0)
        assert.ok(milestones.some((l) => /story_merged S1/.test(l)), milestones.join("|"))
        assert.match(outcomes[0] ?? "", /^baro run succeeded\./)
        assert.match(registry.status(run.id), /\[completed\]/)
    })

    it("keeps the stderr tail for a failed run's status", async () => {
        const registry = new RunRegistry({ baroBin: fakeBaro })
        const { run } = registry.delegate("fail goal", dir)
        const done = await finished(registry, run.id)
        assert.equal(done.terminal, "error")
        const status = registry.status(run.id)
        assert.match(status, /baro run failed \(shell_timeout\)/)
        assert.match(status, /stderr tail:\nboom/)
    })

    it("queues a second goal for the same repository and starts it when the first exits", async () => {
        const started: string[] = []
        const registry = new RunRegistry({
            baroBin: fakeBaro,
            onStarted: (run) => started.push(run.id),
        })
        const first = registry.delegate("slow goal", dir)
        const second = registry.delegate("quick goal", dir)
        assert.equal(second.behind?.id, first.run.id)
        assert.equal(registry.stateOf(second.run), "queued")
        assert.match(registry.table(), /queued behind run-1/)
        assert.match(registry.status(second.run.id), /queued: baro allows one run per repository/)

        const other = registry.delegate("quick goal", join(dir, "other"))
        assert.equal(other.behind, null, "a different repository is not queued")

        await finished(registry, first.run.id)
        await finished(registry, second.run.id)
        assert.deepEqual(started, [second.run.id])
        assert.equal(second.run.terminal, "completed")
        assert.ok(second.run.startedAt! >= first.run.finishedAt!, "second started after first exited")
    })

    it("stops a queued run without ever spawning it", async () => {
        const registry = new RunRegistry({ baroBin: fakeBaro })
        const first = registry.delegate("slow goal", dir)
        const second = registry.delegate("quick goal", dir)
        assert.equal(registry.stop(second.run.id), true)
        assert.equal(second.run.terminal, "aborted")
        await finished(registry, first.run.id)
        await new Promise((r) => setTimeout(r, 50))
        assert.equal(second.run.startedAt, null, "never started")
        assert.equal(registry.running().length, 0)
    })
})
