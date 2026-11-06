#!/usr/bin/env node
// Summarizes a spawn trace: total time and count per kind of child process, and
// the slowest individual processes with their offset from the first one.
//
//   node bench/profile/summarize.mjs trace.jsonl [--top 25]

import { readFileSync } from "node:fs"

const [file, ...rest] = process.argv.slice(2)
const topIndex = rest.indexOf("--top")
const top = topIndex >= 0 ? Number(rest[topIndex + 1]) : 25
const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
if (rows.length === 0) {
    console.log("empty trace")
    process.exit(0)
}
const t0 = Math.min(...rows.map((r) => r.started))
const kind = (r) => {
    const [name, second, third] = r.what.split(" ")
    if (name === "git") return `git ${second ?? ""}`.trim()
    if (second?.startsWith("model=")) return `${name} ${second}`
    if (name === "node" || name === "npm" || name === "npx") return `${name} ${second ?? ""} ${third ?? ""}`.trim()
    return name
}

const groups = new Map()
for (const r of rows) {
    const k = kind(r)
    const g = groups.get(k) ?? { kind: k, count: 0, ms: 0, max: 0 }
    g.count += 1
    g.ms += r.ms
    g.max = Math.max(g.max, r.ms)
    groups.set(k, g)
}
const secs = (ms) => (ms / 1000).toFixed(1)
console.log("By kind (summed; parallel processes overlap):\n")
console.log("total s  count  max s  kind")
for (const g of [...groups.values()].sort((a, b) => b.ms - a.ms).slice(0, top)) {
    console.log(`${secs(g.ms).padStart(7)}  ${String(g.count).padStart(5)}  ${secs(g.max).padStart(5)}  ${g.kind}`)
}
console.log(`\nSlowest ${top} processes (start offset, duration):\n`)
for (const r of [...rows].sort((a, b) => b.ms - a.ms).slice(0, top)) {
    console.log(`${secs(r.started - t0).padStart(7)}s  ${secs(r.ms).padStart(6)}s  ${r.what.slice(0, 110)}`)
}
