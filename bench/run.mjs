#!/usr/bin/env node
// Runs the benchmark suite against one Baro build and writes per-case streams plus
// summary.json. Cases run one at a time so timings are not skewed by each other.
//
//   node bench/run.mjs --label v0.122.1 --baro "npx --yes baro-ai@0.122.1"
//   node bench/run.mjs --label local --baro ~/.baro/local-v4/baro --only bugfix,shared-file

import { spawn, execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { metrics, parseStream } from "./metrics.mjs"

const here = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
    const opts = { model: "sonnet", llm: "claude", timeoutMin: 30, only: null, label: null, baro: null, out: null, trace: false, repeat: 1, env: {} }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, "")
        if (key === "trace") {
            opts.trace = true
            continue
        }
        const value = argv[++i]
        if (key === "only") opts.only = value.split(",")
        else if (key === "timeout-min") opts.timeoutMin = Number(value)
        else if (key === "repeat") opts.repeat = Math.max(1, Number(value))
        else if (key === "env") {
            const at = value.indexOf("=")
            if (at < 1) throw new Error("--env takes KEY=VALUE")
            opts.env[value.slice(0, at)] = value.slice(at + 1)
        }
        else if (key in opts) opts[key] = value
        else throw new Error(`unknown option --${key}`)
    }
    if (!opts.label || !opts.baro) {
        throw new Error('usage: node bench/run.mjs --label <name> --baro "<command>" [--model sonnet] [--only a,b] [--timeout-min 30] [--out dir] [--trace] [--repeat 3] [--env KEY=VALUE] [--llm openai]')
    }
    opts.out ??= join(here, "results", opts.label)
    return opts
}

// A case runs on a copied fixture, or on a real repository cloned at a fixed commit.
function prepareRepo(testCase, dir) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    if (testCase.repo) {
        const source = testCase.repo.path.replace(/^~/, process.env.HOME)
        execFileSync("git", ["clone", "-q", "--no-hardlinks", source, dir], { stdio: "ignore" })
        execFileSync("git", ["checkout", "-q", "-B", "main", testCase.repo.commit], { cwd: dir, stdio: "ignore" })
        execFileSync("git", ["remote", "remove", "origin"], { cwd: dir, stdio: "ignore" })
        return
    }
    const fixture = testCase.fixture
    cpSync(join(here, "fixtures", fixture), dir, { recursive: true })
    // Fixtures keep their ignore file unhidden so it cannot apply to this repository.
    if (existsSync(join(dir, "gitignore"))) renameSync(join(dir, "gitignore"), join(dir, ".gitignore"))
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-qm", "fixture")
}

function runCase(opts, testCase, dir, streamPath, errPath, tracePath) {
    const [bin, ...pre] = opts.baro.split(" ").filter(Boolean)
    // "default" leaves every role on Baro's own choice, as a user's run would be.
    const roles = opts.model === "default"
        ? []
        : ["architect", "planner", "story", "surgeon", "critic"].flatMap((r) => [`--${r}-model`, opts.model])
    const args = [...pre, "--headless", "--local-only", "--llm", opts.llm, ...roles, "--cwd", dir, testCase.goal]
    return new Promise((done) => {
        const startedAt = Date.now()
        // --trace: every Node process Baro starts records its own child processes.
        const env = opts.trace
            ? {
                  ...process.env,
                  ...opts.env,
                  BARO_SPAWN_TRACE: tracePath,
                  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${join(here, "profile", "spawn-trace.mjs")}`.trim(),
              }
            : { ...process.env, ...opts.env }
        if (opts.trace) rmSync(tracePath, { force: true })
        const child = spawn(bin.replace(/^~/, process.env.HOME), args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env })
        const out = []
        const err = []
        child.stdout.on("data", (b) => out.push(b))
        child.stderr.on("data", (b) => err.push(b))
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            try {
                process.kill(-child.pid, "SIGTERM")
            } catch {}
        }, opts.timeoutMin * 60_000)
        child.on("close", (code) => {
            clearTimeout(timer)
            const text = Buffer.concat(out).toString("utf8")
            writeFileSync(streamPath, text)
            writeFileSync(errPath, Buffer.concat(err))
            done({ text, startedAt, wallSecs: Math.round((Date.now() - startedAt) / 100) / 10, exitCode: code, timedOut })
        })
    })
}

const median = (values) => {
    const xs = values.filter((x) => typeof x === "number").sort((a, b) => a - b)
    if (xs.length === 0) return null
    const mid = Math.floor(xs.length / 2)
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

// One run is reported as is. Repeats report the median of each number, and a
// case succeeds only if every repeat did; the individual runs are kept.
function aggregate(runs) {
    if (runs.length === 1) return runs[0]
    const numeric = ["wall_secs", "total_secs", "architect_secs", "to_first_story_secs", "stories_secs", "finalize_secs", "story_count", "retries", "replans", "cost_usd"]
    return {
        ...runs[0],
        ...Object.fromEntries(numeric.map((key) => [key, median(runs.map((r) => r[key]))])),
        success: runs.every((r) => r.success),
        repeats: runs.length,
        runs,
    }
}

const fmt = (x, d = 0) => (x == null ? "-" : Number(x).toFixed(d))

async function main() {
    const opts = parseArgs(process.argv.slice(2))
    const suite = JSON.parse(readFileSync(join(here, "suite.json"), "utf8"))
    const cases = suite.cases.filter((c) => !opts.only || opts.only.includes(c.id))
    mkdirSync(opts.out, { recursive: true })
    const summaryPath = join(opts.out, "summary.json")
    const summary = existsSync(summaryPath)
        ? JSON.parse(readFileSync(summaryPath, "utf8"))
        : { label: opts.label, baro: opts.baro, model: opts.model, env: opts.env, cases: {} }
    for (const testCase of cases) {
        const runs = []
        for (let rep = 1; rep <= opts.repeat; rep++) {
            const name = opts.repeat > 1 ? `${testCase.id}.r${rep}` : testCase.id
            const dir = join(tmpdir(), "baro-bench", opts.label, name)
            prepareRepo(testCase, dir)
            process.stdout.write(`${name}: running in ${dir} ... `)
            const r = await runCase(
                opts,
                testCase,
                dir,
                join(opts.out, `${name}.jsonl`),
                join(opts.out, `${name}.stderr.txt`),
                join(opts.out, `${name}.trace.jsonl`),
            )
            const m = metrics(parseStream(r.text), { startedAt: r.startedAt })
            runs.push({ ...m, wall_secs: r.wallSecs, exit_code: r.exitCode, timed_out: r.timedOut, ran_at: new Date(r.startedAt).toISOString() })
            console.log(`${m.success ? "ok" : "FAILED"} ${fmt(r.wallSecs)}s $${fmt(m.cost_usd, 2)} stories=${m.story_count}`)
        }
        summary.cases[testCase.id] = aggregate(runs)
        writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n")
    }
    console.log(`\n${resolve(summaryPath)}`)
}

main().catch((e) => {
    console.error(e.message)
    process.exit(1)
})
