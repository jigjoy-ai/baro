#!/usr/bin/env node
// Lists every contract conflict the Critic reported in a set of runs, with the
// follow-up stories it caused, so each report can be judged by hand: was the
// criterion really outside the story's write surface, or really contradictory?
//
//   node bench/audit-conflicts.mjs bench/results/<label> [more dirs...]

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseStream } from "./metrics.mjs"

let reports = 0
let runs = 0
const byKind = {}
for (const dir of process.argv.slice(2)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl") && !name.endsWith(".trace.jsonl")).sort()) {
        const events = parseStream(readFileSync(join(dir, file), "utf8"))
        runs += 1
        const done = events.findLast?.((e) => e.type === "done") ?? [...events].reverse().find((e) => e.type === "done")
        const transfers = events.filter((e) => e.type === "replan" && String(e.reason ?? "").startsWith("contract transfer from "))
        const seen = new Set()
        const lines = []
        for (const e of events) {
            if (e.type !== "turn_review" || !Array.isArray(e.contract_conflicts)) continue
            for (const c of e.contract_conflicts) {
                const key = `${e.id}\u0000${c.criterion}`
                if (seen.has(key)) continue
                seen.add(key)
                reports += 1
                byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
                lines.push(`  [${c.kind}] ${e.id} turn ${e.turn} (${e.verdict})\n    criterion: ${c.criterion}\n    reason:    ${c.reason}`)
            }
        }
        if (lines.length === 0 && transfers.length === 0) continue
        console.log(`== ${dir}/${file}  success=${done?.success === true} verification=${done?.verification_status ?? "-"}`)
        for (const line of lines) console.log(line)
        for (const t of transfers) {
            const ids = (t.added ?? []).map((s) => s.id).join(", ")
            const reviews = events.filter((e) => e.type === "turn_review" && (t.added ?? []).some((s) => s.id === e.id))
            console.log(`  -> ${t.reason} => ${ids}; follow-up reviews: ${reviews.map((r) => `${r.verdict}`).join(", ") || "none"}`)
        }
    }
}
console.log(`\n${reports} distinct conflict reports in ${runs} runs: ${JSON.stringify(byKind)}`)
