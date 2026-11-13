import { afterEach, beforeEach, describe, it } from "@rstest/core"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type {
    StoryExecOpts,
    StoryExecution,
    StoryExecutor,
} from "../../src/execution/story-executor.js"
import type { StoryRoute } from "../../src/market/routing.js"
import { orchestrate } from "../../src/orchestrate.js"
import type { CoordinationBus } from "../../src/runtime/coordination.js"
import { StoryResult, type StorySpawnRequestData } from "../../src/semantic-events.js"
import {
    CARGO_LEFTOVER_MAX_AGE_MS,
    cargoTargetCacheRoots,
    pruneCargoTargetCaches,
} from "../../src/verification/cargo-target-prune.js"

const STALE_MS = CARGO_LEFTOVER_MAX_AGE_MS + 60 * 60_000

let scratch: string
let logs: string[]

beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "baro-cargo-prune-")))
    logs = []
})

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
})

function touch(path: string, content = "x", ageMs = 0): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    if (ageMs > 0) backdate(path, ageMs)
}

function backdate(path: string, ageMs: number): void {
    const when = new Date(Date.now() - ageMs)
    if (lstatSync(path).isDirectory()) {
        for (const name of readdirSync(path)) backdate(join(path, name), ageMs)
    }
    utimesSync(path, when, when)
}

/** A profile with one unit as cargo lays it out, all of it old. */
function oldUnit(profile: string, unit: string): void {
    for (const name of [`${unit}.d`, `lib${unit}.rlib`, `lib${unit}.rmeta`, unit]) {
        touch(join(profile, "deps", name), "r", STALE_MS)
    }
    touch(join(profile, ".fingerprint", unit, "lib-demo.json"), "{}", STALE_MS)
}

function prune(roots: string[]) {
    return pruneCargoTargetCaches({ roots, log: (line) => logs.push(line) })
}

describe("pruneCargoTargetCaches", () => {
    it("drops leftover object files past the age limit and keeps every unit's outputs", () => {
        const root = join(scratch, "cache", "cargo-target")
        const profile = join(root, "repo-abc", "debug")
        oldUnit(profile, "demo-aa11")
        oldUnit(profile, "serde-bb22")
        touch(join(profile, "deps", "demo-aa11.cgu1.s0old.rcgu.o"), "o".repeat(4096), STALE_MS)
        touch(join(profile, "deps", "demo-aa11.cgu2.s0old.rcgu.o"), "o".repeat(4096), STALE_MS)
        touch(join(profile, "deps", "demo-aa11.cgu1.s1new.rcgu.o"), "o")
        touch(join(profile, "examples", "ex-cc33.cgu1.s0old.rcgu.o"), "o", STALE_MS)
        const triple = join(root, "repo-abc", "aarch64-apple-darwin", "debug")
        oldUnit(triple, "demo-aa11")
        touch(join(triple, "deps", "demo-aa11.cgu1.s0old.rcgu.o"), "o", STALE_MS)

        const summary = prune([root])

        assert.deepEqual(readdirSync(join(profile, "deps")).sort(), [
            "demo-aa11", "demo-aa11.cgu1.s1new.rcgu.o", "demo-aa11.d",
            "libdemo-aa11.rlib", "libdemo-aa11.rmeta", "libserde-bb22.rlib", "libserde-bb22.rmeta",
            "serde-bb22", "serde-bb22.d",
        ])
        assert.deepEqual(readdirSync(join(profile, ".fingerprint")).sort(), ["demo-aa11", "serde-bb22"])
        assert.deepEqual(readdirSync(join(profile, "examples")), [])
        assert.deepEqual(readdirSync(join(triple, "deps")).sort(), [
            "demo-aa11", "demo-aa11.d", "libdemo-aa11.rlib", "libdemo-aa11.rmeta",
        ])
        assert.equal(summary.objects, 4)
        assert.ok(summary.bytes >= 2 * 4096)
        assert.ok(logs.some((line) => line.startsWith("pruned 4 leftover object file(s)")), logs.join("\n"))
    })

    it("drops incremental dirs past the age limit across every cache root", () => {
        const roots = [join(scratch, "a"), join(scratch, "b")]
        const profile = join(roots[1], "repo-x", "debug")
        mkdirSync(join(profile, ".fingerprint"), { recursive: true })
        const stale = join(profile, "incremental", "demo-1")
        const fresh = join(profile, "incremental", "demo-2")
        touch(join(stale, "s-1", "dep-graph.bin"))
        touch(join(fresh, "s-2", "dep-graph.bin"))
        backdate(stale, STALE_MS)

        const summary = prune(roots)

        assert.equal(existsSync(stale), false)
        assert.equal(existsSync(fresh), true)
        assert.equal(summary.incremental, 1)
    })

    it("does nothing and says nothing when no cache exists", () => {
        assert.deepEqual(prune([join(scratch, "missing")]), { objects: 0, incremental: 0, bytes: 0 })
        assert.deepEqual(logs, [])
    })

    it("names the story package cache and the verification cache as its roots", () => {
        const roots = cargoTargetCacheRoots({ BARO_PACKAGE_CACHE: join(scratch, "pkg") })
        assert.equal(roots[0], join(scratch, "pkg", "cargo-target"))
        assert.ok(roots[1].endsWith(join(".baro", "cargo-target")))
    })
})

const cargoAvailable = spawnSync("cargo", ["--version"]).status === 0

describe.skipIf(!cargoAvailable)("pruneCargoTargetCaches with real cargo", () => {
    it("keeps a story worktree's build fresh after pruning what an earlier build left", () => {
        const cacheRoot = join(scratch, "cache", "cargo-target")
        const target = join(cacheRoot, "demo-key")
        const crate = (run: string) => join(scratch, "baro-worktrees", run, "S1", "demo")
        const write = (run: string, body: string) => {
            mkdirSync(join(crate(run), "src"), { recursive: true })
            writeFileSync(
                join(crate(run), "Cargo.toml"),
                '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
            )
            writeFileSync(join(crate(run), "src", "main.rs"), body)
        }
        const cargo = (run: string) =>
            execFileSync("cargo", ["build", "--offline", "--message-format=json"], {
                cwd: crate(run),
                env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: "1" },
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            })
        const objects = () => readdirSync(join(target, "debug", "deps")).filter((n) => n.endsWith(".rcgu.o"))
        write("run-a", 'fn main() { println!("a"); }\n')
        cargo("run-a")
        backdate(target, STALE_MS)
        write("run-b", 'fn main() { println!("b"); }\nfn _two() -> u8 { 2 }\n')
        cargo("run-b")
        const deps = join(target, "debug", "deps")
        const stale = objects().filter((name) => lstatSync(join(deps, name)).mtimeMs < Date.now() - STALE_MS / 2)
        if (process.platform === "darwin") {
            assert.ok(stale.length > 0, "the earlier build left object files behind")
        }

        const summary = prune([cacheRoot])

        assert.equal(summary.objects, stale.length)
        for (const name of stale) {
            assert.equal(existsSync(join(deps, name)), false, `${name} should be pruned`)
        }
        assert.equal(readdirSync(join(target, "debug", "incremental")).length, 1)
        const demo = cargo("run-b")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { reason: string; target?: { name: string }; fresh?: boolean })
            .filter((message) => message.reason === "compiler-artifact" && message.target?.name === "demo")
        assert.deepEqual(demo.map((message) => message.fresh), [true])
    })
})

class NoopExecutor implements StoryExecutor {
    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: CoordinationBus,
        options: StoryExecOpts,
    ): StoryExecution {
        const source = { agentId: request.storyId } as never
        options.registerResultAuthority?.(source)
        setImmediate(() => {
            environment.publish(
                source,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

describe("orchestrate() run start", () => {
    const saved: Record<string, string | undefined> = {}
    let stderrWrite: typeof process.stderr.write

    beforeEach(() => {
        for (const key of ["HOME", "BARO_PACKAGE_CACHE", "TMPDIR", "BARO_RUN_START_CLEANUP"]) {
            saved[key] = process.env[key]
        }
        process.env.HOME = join(scratch, "home")
        process.env.BARO_PACKAGE_CACHE = join(scratch, "pkg")
        process.env.TMPDIR = scratch
        delete process.env.BARO_RUN_START_CLEANUP
        stderrWrite = process.stderr.write
    })

    afterEach(() => {
        process.stderr.write = stderrWrite
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })

    it("prunes both cargo target caches and prints what it reclaimed", async () => {
        const storyObject = join(scratch, "pkg", "cargo-target", "repo-k", "debug", "deps", "demo-1.cgu.s.rcgu.o")
        const verifyObject = join(scratch, "home", ".baro", "cargo-target", "repo-k", "debug", "deps", "demo-1.cgu.s.rcgu.o")
        for (const object of [storyObject, verifyObject]) {
            touch(object, "o", STALE_MS)
            mkdirSync(join(dirname(dirname(object)), ".fingerprint"))
        }
        const repo = join(scratch, "repo")
        mkdirSync(repo)
        const prdPath = join(repo, "prd.json")
        writeFileSync(prdPath, JSON.stringify({
            project: "prune",
            branchName: "baro/prune",
            description: "prune",
            userStories: [{
                id: "S1", priority: 1, title: "S1", description: "S1", dependsOn: [], retries: 1,
                acceptance: ["S1"], tests: [], passes: false, completedAt: null, durationSecs: null,
                model: "standard",
            }],
        }) + "\n")
        const stderr: string[] = []
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderr.push(String(chunk))
            return true
        }) as typeof process.stderr.write

        const result = await orchestrate({
            prdPath, cwd: repo, runId: "run-prune-test", publishRemote: false,
            withGit: false, greenfieldInit: false, emitTuiEvents: false, withLibrarian: false,
            withMemory: false, withSentry: false, withCritic: false, withSurgeon: false,
            withSupervisor: false, intraLevelDelaySecs: 0, executor: new NoopExecutor(),
        })
        process.stderr.write = stderrWrite

        assert.deepEqual(result.summary.completedStories, ["S1"])
        assert.equal(existsSync(storyObject), false)
        assert.equal(existsSync(verifyObject), false)
        assert.ok(
            stderr.some((line) => line.startsWith("[cargo] pruned 2 leftover object file(s)")),
            stderr.join(""),
        )
    })

    it("leaves the caches alone under BARO_RUN_START_CLEANUP=0", async () => {
        const object = join(scratch, "pkg", "cargo-target", "repo-k", "debug", "deps", "demo-1.cgu.s.rcgu.o")
        touch(object, "o", STALE_MS)
        const repo = join(scratch, "repo")
        mkdirSync(repo)
        const prdPath = join(repo, "prd.json")
        writeFileSync(prdPath, JSON.stringify({
            project: "prune",
            branchName: "baro/prune",
            description: "prune",
            userStories: [{
                id: "S1", priority: 1, title: "S1", description: "S1", dependsOn: [], retries: 1,
                acceptance: ["S1"], tests: [], passes: false, completedAt: null, durationSecs: null,
                model: "standard",
            }],
        }) + "\n")
        process.env.BARO_RUN_START_CLEANUP = "0"

        const result = await orchestrate({
            prdPath, cwd: repo, runId: "run-prune-off-test", publishRemote: false,
            withGit: false, greenfieldInit: false, emitTuiEvents: false, withLibrarian: false,
            withMemory: false, withSentry: false, withCritic: false, withSurgeon: false,
            withSupervisor: false, intraLevelDelaySecs: 0, executor: new NoopExecutor(),
        })

        assert.deepEqual(result.summary.completedStories, ["S1"])
        assert.equal(existsSync(object), true)
    })
})
