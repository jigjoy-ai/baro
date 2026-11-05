import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, it } from "node:test"

import { build } from "esbuild"

import {
    assertHookContainsShell,
    materializePublishGuardHooks,
} from "../../src/harness/claude/hook-bridge.js"

const HOOK_BRIDGE = resolve(import.meta.dirname, "../../src/harness/claude/hook-bridge.ts")

// The Claude lane's shell hook is serialized source. In the published bundle
// esbuild renamed shell-containment's `fs` import to `fs4`, the hook threw on
// every command and, failing open, let `rm -rf ~/...` through. Unit tests run
// under tsx, where nothing is renamed, so they could not see it.
describe("the Claude lane's hook, built the way it ships", () => {
    it("refuses commands that leave the worktree when its imports were renamed by the bundler", async () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-hook-bundle-"))
        try {
            // A second module with the same import forces esbuild to rename one.
            writeFileSync(
                join(dir, "collide.ts"),
                'import * as fs from "fs"\nexport const touch = () => fs.existsSync("/")\n',
            )
            writeFileSync(
                join(dir, "entry.ts"),
                [
                    `import { touch } from "./collide.ts"`,
                    `import { materializePublishGuardHooks } from ${JSON.stringify(HOOK_BRIDGE)}`,
                    `touch()`,
                    `materializePublishGuardHooks(process.argv[2], process.argv[3])`,
                ].join("\n"),
            )
            await build({
                entryPoints: [join(dir, "entry.ts")],
                bundle: true,
                platform: "node",
                format: "esm",
                outfile: join(dir, "bundle.mjs"),
                logLevel: "silent",
            })
            const hookDir = join(dir, "hooks")
            const worktree = mkdtempSync(join(dir, "worktree-"))
            execFileSync(process.execPath, [join(dir, "bundle.mjs"), hookDir, worktree])

            for (const command of ["rm -rf ~/Documents", "cd .. && ls", "cat /etc/hosts > ../leak"]) {
                const out = execFileSync(process.execPath, [join(hookDir, "hook.mjs"), "pre-bash"], {
                    input: JSON.stringify({ tool_input: { command }, cwd: worktree }),
                    encoding: "utf8",
                })
                assert.equal(JSON.parse(out).decision, "block", command)
                assert.doesNotMatch(out, /could not check/, `${command} was judged, not refused by error`)
            }
            const inside = execFileSync(process.execPath, [join(hookDir, "hook.mjs"), "pre-bash"], {
                input: JSON.stringify({ tool_input: { command: "ls src" }, cwd: worktree }),
                encoding: "utf8",
            })
            assert.equal(inside, "", "a command inside the worktree is allowed")

            // A file tool writes outside the worktree as easily as a shell does:
            // in one run an agent's Write landed one directory above it.
            const write = (file_path: string) =>
                execFileSync(process.execPath, [join(hookDir, "hook.mjs"), "pre-write"], {
                    input: JSON.stringify({ tool_input: { file_path }, cwd: worktree }),
                    encoding: "utf8",
                })
            for (const outside of [join(worktree, "..", "escaped.py"), "/etc/escaped", "../escaped.py"]) {
                assert.match(write(outside), /outside your worktree/, outside)
            }
            for (const ok of [join(worktree, "src", "new.py"), "src/new.py", ".baro-scratch/venv/x"]) {
                assert.equal(write(ok), "", ok)
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("fails closed when the containment check cannot run", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-hook-broken-"))
        try {
            materializePublishGuardHooks(dir, dir)
            const hook = join(dir, "hook.mjs")
            const source = execFileSync("cat", [hook], { encoding: "utf8" })
            // Break the check the way the bundle did: an unbound name.
            const broken = source.replace(
                /function hasMacosWriteSandbox\(\)\s*\{/u,
                "$& return missingBinding.x;",
            )
            assert.notEqual(broken, source, "the test must actually break the check")
            writeFileSync(hook, broken)
            const out = execFileSync(process.execPath, [hook, "pre-bash"], {
                input: JSON.stringify({ tool_input: { command: "ls" }, cwd: dir }),
                encoding: "utf8",
            })
            assert.equal(JSON.parse(out).decision, "block")
            assert.match(out, /could not check this command/)
            assert.throws(() => assertHookContainsShell(hook), /does not judge shell commands/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
