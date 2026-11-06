// Preload (NODE_OPTIONS="--import <this file>") that appends one line per child
// process to $BARO_SPAWN_TRACE: start, end, duration and the command, so a run's
// wall time can be attributed to git, model CLIs, installs and tests.
import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { appendFileSync } from "node:fs"

const file = process.env.BARO_SPAWN_TRACE
if (file) {
    const describe = (cmd, args) => {
        const list = Array.isArray(args) ? args : []
        const name = String(cmd).split("/").pop()
        const model = list.indexOf("--model")
        const head = list.filter((a) => typeof a === "string" && !a.startsWith("--") && a.length < 60).slice(0, 3)
        return [name, ...(model >= 0 ? [`model=${list[model + 1]}`] : []), ...head].join(" ").replace(/\s+/g, " ")
    }
    const record = (fields) => {
        try {
            appendFileSync(file, JSON.stringify({ pid: process.pid, ...fields }) + "\n")
        } catch {}
    }
    for (const name of ["spawn", "execFile"]) {
        const original = cp[name]
        cp[name] = function (cmd, args, ...rest) {
            const started = Date.now()
            const child = original.call(this, cmd, args, ...rest)
            const what = describe(cmd, args)
            child?.once?.("close", (code) => record({ api: name, what, started, ms: Date.now() - started, code }))
            return child
        }
    }
    for (const name of ["spawnSync", "execFileSync"]) {
        const original = cp[name]
        cp[name] = function (cmd, args, ...rest) {
            const started = Date.now()
            try {
                return original.call(this, cmd, args, ...rest)
            } finally {
                record({ api: name, what: describe(cmd, args), started, ms: Date.now() - started })
            }
        }
    }
    syncBuiltinESMExports()
}
