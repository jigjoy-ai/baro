import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { runCodexOneShot } from "../src/codex-one-shot.js"
import { withTempDir } from "./participants/helpers.js"

/** Fake codex: emits agent_message lines, then optionally hangs, then exits. */
function writeFakeCodex(
    dir: string,
    opts: { texts: string[]; exitCode?: number; hangMs?: number },
): string {
    const bin = join(dir, "fake-codex.mjs")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
const texts = ${JSON.stringify(opts.texts)};
for (const text of texts) {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
}
${opts.hangMs ? `await new Promise((r) => setTimeout(r, ${opts.hangMs}));` : ""}
process.exit(${opts.exitCode ?? 0});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

describe("runCodexOneShot exit contract", () => {
    it("resolves the agent message on a clean exit", async () => {
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["design doc"] })

            const result = await runCodexOneShot({ prompt: "goal", cwd: dir, codexBin: bin })
            assert.equal(result, "design doc")
        })
    })

    it("rejects on a non-zero exit instead of returning the partial output", async () => {
        // Codex streams part of the answer, then crashes. The partial text
        // must not come back as success — a truncated PRD parses as a
        // smaller-but-valid plan downstream.
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["stories 1-9 of 12…"], exitCode: 3 })

            await assert.rejects(
                runCodexOneShot({ prompt: "goal", cwd: dir, codexBin: bin }),
                /terminated abnormally.*exit=3/,
            )
        })
    })

    it("rejects on timeout instead of returning the partial output", async () => {
        await withTempDir("baro-codex-exit-", async (dir) => {
            const bin = writeFakeCodex(dir, { texts: ["partial…"], hangMs: 30_000 })

            await assert.rejects(
                runCodexOneShot({ prompt: "goal", cwd: dir, codexBin: bin, timeoutMs: 200 }),
                /terminated abnormally.*timedOut=true/,
            )
        })
    })
})
