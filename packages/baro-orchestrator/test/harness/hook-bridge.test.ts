import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { materializeStoryHooks } from "../../src/harness/claude/hook-bridge.js"

const dir = mkdtempSync(join(tmpdir(), "baro-hook-test-"))
after(() => rmSync(dir, { recursive: true, force: true }))

function runHook(mode: string, input: unknown): string {
    return execFileSync("node", [join(dir, "hook.mjs"), mode], {
        input: JSON.stringify(input),
        encoding: "utf8",
    })
}

describe("hook bridge — the agent's world shows the mechanisms", () => {
    const settings = materializeStoryHooks(
        dir,
        {
            writes: ["src/mine.ts"],
            ownedElsewhere: { "src/theirs.ts": "S2" },
        },
        { command: "agent-collab", capability: "note" },
    )

    it("materializes trusted settings wiring both hook events", () => {
        assert.ok(settings && existsSync(settings))
        const parsed = JSON.parse(readFileSync(settings!, "utf8"))
        assert.ok(parsed.hooks.PostToolUse[0].matcher === "Bash")
        assert.match(parsed.hooks.PreToolUse[0].matcher, /Write\|Edit/)
    })

    it("acknowledges evidence capture on a verification command, and only there", () => {
        const out = runHook("post-bash", {
            tool_input: { command: "npm test 2>&1 | tail -30" },
        })
        assert.match(out, /\[gate:evidence-capture\]/)
        assert.match(out, /do not re-run/i)

        assert.equal(
            runHook("post-bash", { tool_input: { command: "ls -la" } }),
            "",
            "an ordinary command gets no lecture",
        )
    })

    it("refuses a write into another story's surface at the write, with the registry's remedy", () => {
        const out = runHook("pre-write", {
            tool_input: { file_path: "src/theirs.ts" },
        })
        const parsed = JSON.parse(out)
        assert.equal(parsed.decision, "block")
        assert.equal(
            parsed.hookSpecificOutput.permissionDecision,
            "deny",
        )
        assert.match(parsed.reason, /\[gate:write-surface\]/)
        assert.match(parsed.reason, /belongs to story S2/)
        assert.match(parsed.reason, /Ask the owner/)
    })

    it("lets the story write inside its own surface without a word", () => {
        assert.equal(
            runHook("pre-write", { tool_input: { file_path: "src/mine.ts" } }),
            "",
        )
    })

    it("a hook must never break the agent: malformed input exits clean and silent", () => {
        const out = execFileSync("node", [join(dir, "hook.mjs"), "pre-write"], {
            input: "not json at all",
            encoding: "utf8",
        })
        assert.equal(out, "")
    })

    it("a story with no surface gets no hooks at all", () => {
        assert.equal(
            materializeStoryHooks(join(dir, "none"), undefined, {
                command: "c",
                capability: "n",
            }),
            null,
        )
    })
})
