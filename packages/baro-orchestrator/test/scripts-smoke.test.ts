import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"

const exec = promisify(execFile)
const SCRIPTS = join(import.meta.dirname, "..", "scripts")

// Regression guard: each CLI script must actually INVOKE its main() when run.
// A dropped `main().catch(...)` tree-shakes the whole entry out of the
// published bundle and the script becomes a silent no-op (shipped in 0.70.14).
async function runScript(name: string, args: string[]): Promise<{ code: number; stderr: string }> {
    try {
        await exec(process.execPath, ["--import", "tsx", join(SCRIPTS, name), ...args], { timeout: 30_000 })
        return { code: 0, stderr: "" }
    } catch (e) {
        const err = e as { code?: number; stderr?: string }
        return { code: err.code ?? -1, stderr: err.stderr ?? "" }
    }
}

describe("script entrypoints run their main()", () => {
    it("run-planner rejects missing args (proves main executes)", async () => {
        const r = await runScript("run-planner.ts", [])
        assert.equal(r.code, 2)
        assert.match(r.stderr, /--goal is required/)
    })

    it("run-planner knows --mode-file (regression: 0.70.14 shipped without it)", async () => {
        const r = await runScript("run-planner.ts", ["--mode-file"])
        assert.equal(r.code, 2)
        assert.match(r.stderr, /--mode-file requires a value/)
    })

    it("run-intake rejects missing args (proves main executes)", async () => {
        const r = await runScript("run-intake.ts", [])
        assert.equal(r.code, 2)
        assert.match(r.stderr, /--goal is required/)
    })
})
