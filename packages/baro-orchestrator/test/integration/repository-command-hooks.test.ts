import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import { runRepositoryCommand } from "../../src/integration/repository-command.js"

// A story can commit a hooks directory or point the shared config at one; the
// orchestrator then merges and commits with the user's account.
describe.skipIf(process.platform === "win32")("the orchestrator's git ignores repository hooks", () => {
    it("runs no planted hook, where plain git would", async () => {
        const repo = mkdtempSync(join(tmpdir(), "baro-git-hooks-"))
        try {
            const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
            git("init", "-q")
            git("config", "user.email", "t@t.t")
            git("config", "user.name", "t")
            mkdirSync(join(repo, ".githooks"))
            const marker = join(repo, "hook-ran")
            writeFileSync(join(repo, ".githooks", "post-commit"), `#!/bin/sh\ntouch "${marker}"\n`)
            chmodSync(join(repo, ".githooks", "post-commit"), 0o755)
            git("config", "core.hooksPath", ".githooks")

            await runRepositoryCommand("git", ["commit", "--allow-empty", "-q", "-m", "baro"], { cwd: repo })
            assert.equal(existsSync(marker), false, "the orchestrator's commit ran no hook")

            git("commit", "--allow-empty", "-q", "-m", "plain")
            assert.equal(existsSync(marker), true, "control: plain git does run it")
        } finally {
            rmSync(repo, { recursive: true, force: true })
        }
    })
})
