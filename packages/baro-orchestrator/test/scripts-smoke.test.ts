import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { join } from "node:path"

const exec = promisify(execFile)
const SCRIPTS = join(import.meta.dirname, "..", "scripts")

// Regression guard: each CLI script must actually INVOKE its main() when run.
// A dropped `main().catch(...)` tree-shakes the whole entry out of the
// published bundle and the script becomes a silent no-op (shipped in 0.70.14).
async function runScript(
    name: string,
    args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
        const result = await exec(
            process.execPath,
            ["--import", "tsx", join(SCRIPTS, name), ...args],
            { timeout: 30_000 },
        )
        return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string }
        return {
            code: err.code ?? -1,
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
        }
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

    it("run-architect knows --mode-file", async () => {
        const r = await runScript("run-architect.ts", ["--mode-file"])
        assert.equal(r.code, 2)
        assert.match(r.stderr, /--mode-file requires a value/)
    })

    it("planner and architect fail closed on an invalid persisted mode contract", async () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-invalid-mode-"))
        try {
            const modeFile = join(dir, "mode.json")
            writeFileSync(modeFile, "{}")
            for (const script of ["run-planner.ts", "run-architect.ts"]) {
                const r = await runScript(script, [
                    "--goal", "test",
                    "--cwd", dir,
                    "--llm", "openai",
                    "--mode-file", modeFile,
                ])
                assert.equal(r.code, 2, `${script}: ${r.stderr}`)
                assert.match(r.stderr, /invalid --mode-file.*must contain mode/)
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("run-intake rejects missing args (proves main executes)", async () => {
        const r = await runScript("run-intake.ts", [])
        assert.equal(r.code, 2)
        assert.match(r.stderr, /--goal is required/)
    })

    it("orchestrator CLI validates the coordination mode", async () => {
        const invalid = await runScript("cli.ts", ["--coordination", "centralized"])
        assert.equal(invalid.code, 2)
        assert.match(invalid.stderr, /legacy.*collective/)

        const collective = await runScript("cli.ts", [
            "--coordination",
            "collective",
            "--prd",
            "missing-experiment-prd.json",
        ])
        assert.equal(collective.code, 2)
        assert.match(collective.stderr, /PRD not found/)
    })

    it("orchestrator CLI rejects invalid collective market numbers", async () => {
        const invalidWindow = await runScript("cli.ts", [
            "--collective-bid-window-ms",
            "NaN",
        ])
        assert.equal(invalidWindow.code, 2)
        assert.match(invalidWindow.stderr, /finite non-negative/)

        const invalidProbability = await runScript("cli.ts", [
            "--collective-min-success",
            "1.1",
        ])
        assert.equal(invalidProbability.code, 2)
        assert.match(invalidProbability.stderr, /between 0 and 1/)
    })

    it("accepts explicit Surgeon opt-outs and documents the LLM-on default", async () => {
        const disabled = await runScript("cli.ts", [
            "--no-surgeon",
            "--no-surgeon-llm",
            "--prd",
            "missing-surgeon-polarity-prd.json",
        ])
        assert.equal(disabled.code, 2)
        assert.match(disabled.stderr, /PRD not found/)
        assert.doesNotMatch(disabled.stderr, /unknown flag/)

        const help = await runScript("cli.ts", ["--help"])
        assert.equal(help.code, 0)
        assert.match(help.stdout, /--no-surgeon\s+Disable Surgeon/)
        assert.match(help.stdout, /--surgeon-use-llm\s+Use LLM evaluation.*default: on/)
        assert.match(help.stdout, /--no-surgeon-llm\s+Use deterministic Surgeon evaluation/)
    })

    it("keeps DialogueAgent collective-only and accepts every safe text backend", async () => {
        const legacy = await runScript("cli.ts", [
            "--coordination",
            "legacy",
            "--with-dialogue",
        ])
        assert.equal(legacy.code, 2)
        assert.match(legacy.stderr, /requires --coordination collective/)

        const codex = await runScript("cli.ts", [
            "--coordination",
            "collective",
            "--with-dialogue",
            "--dialogue-llm",
            "codex",
            "--prd",
            "missing-codex-dialogue-prd.json",
        ])
        assert.equal(codex.code, 2)
        assert.match(codex.stderr, /PRD not found/)
        assert.doesNotMatch(codex.stderr, /dialogue-llm must/)

        const invalidBackend = await runScript("cli.ts", [
            "--dialogue-llm",
            "opencode",
        ])
        assert.equal(invalidBackend.code, 2)
        assert.match(invalidBackend.stderr, /must be 'claude', 'openai', or 'codex'/)

        const help = await runScript("cli.ts", ["--help"])
        assert.equal(help.code, 0)
        assert.match(help.stdout, /dialogue backend: claude\|openai\|codex/)
    })

    it("orchestrator CLI rejects malformed collective worker files before a run", async () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-worker-config-"))
        try {
            writeFileSync(
                join(dir, "prd.json"),
                JSON.stringify({
                    project: "config test",
                    branchName: "baro/config-test",
                    description: "config test",
                    userStories: [],
                }),
            )
            writeFileSync(
                join(dir, "workers.json"),
                JSON.stringify([
                    {
                        workerId: "worker",
                        routeId: "route",
                        route: "claude:haiku",
                        tiers: "standard",
                        estimate: {
                            expectedCostUsd: 0.1,
                            estimatedSuccessProbability: 0.8,
                            estimatedLatencyMs: 100,
                            estimateSource: "configured",
                        },
                    },
                ]),
            )
            const result = await runScript("cli.ts", [
                "--cwd",
                dir,
                "--prd",
                "prd.json",
                "--coordination",
                "collective",
                "--collective-workers",
                "workers.json",
            ])
            assert.equal(result.code, 2)
            assert.match(result.stderr, /worker\[0\]\.tiers/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
