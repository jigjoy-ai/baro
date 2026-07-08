/**
 * Objective build/test VERIFY gate for the fully-merged branch.
 *
 * baro's Critic is an LLM that JUDGES pass/fail against acceptance criteria —
 * it never runs the tests. A per-story gate is unsafe in a shared worktree
 * (sibling stories' incomplete work fails the build through no fault of this
 * story). The one correct place to actually run the build + tests is here, at
 * the end, on the fully-merged branch where everything is present.
 *
 * Semantics that must NOT false-fail:
 *   - ran=false  when nothing could be verified (no manifest, no build/test
 *                script, or the tool is missing/ENOENT). "Couldn't verify" is
 *                not "failed" — it must not force a checkpoint.
 *   - ok=false   only when a build/test that ACTUALLY RAN returned non-zero.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const TIMEOUT_MS = 5 * 60_000
const TAIL_BYTES = 1500

export interface VerifyResult {
    ran: boolean
    ok: boolean
    failures: Array<{ cmd: string; tail: string }>
}

interface VerifyCmd {
    /** Human-readable form for logs + PR body, e.g. "npm run build". */
    label: string
    tool: string
    args: string[]
}

// Build/test commands for whatever the repo root declares. Only scripts that
// actually exist are included — a missing build/test is a skip, never an
// invented command. Build runs before test so a broken build is reported first.
function detectCommands(cwd: string): VerifyCmd[] {
    const cmds: VerifyCmd[] = []

    const pkgPath = join(cwd, "package.json")
    if (existsSync(pkgPath)) {
        let scripts: Record<string, unknown> = {}
        try {
            scripts = (JSON.parse(readFileSync(pkgPath, "utf8"))?.scripts ?? {}) as Record<string, unknown>
        } catch {
            scripts = {}
        }
        const pm = existsSync(join(cwd, "pnpm-lock.yaml"))
            ? "pnpm"
            : existsSync(join(cwd, "yarn.lock"))
              ? "yarn"
              : "npm"
        if (typeof scripts.build === "string") cmds.push({ label: `${pm} run build`, tool: pm, args: ["run", "build"] })
        if (typeof scripts.test === "string") cmds.push({ label: `${pm} run test`, tool: pm, args: ["run", "test"] })
    }

    if (existsSync(join(cwd, "Cargo.toml"))) {
        cmds.push({ label: "cargo build", tool: "cargo", args: ["build"] })
        cmds.push({ label: "cargo test", tool: "cargo", args: ["test"] })
    }

    if (existsSync(join(cwd, "go.mod"))) {
        cmds.push({ label: "go build ./...", tool: "go", args: ["build", "./..."] })
        cmds.push({ label: "go test ./...", tool: "go", args: ["test", "./..."] })
    }

    return cmds
}

type CmdOutcome = { status: "pass" } | { status: "fail"; tail: string } | { status: "skipped" }

async function runCmd(cwd: string, c: VerifyCmd): Promise<CmdOutcome> {
    try {
        await execFileAsync(c.tool, c.args, {
            cwd,
            timeout: TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            shell: process.platform === "win32",
        })
        return { status: "pass" }
    } catch (e) {
        // Tool not installed → we couldn't verify with it. Not a failure.
        if ((e as { code?: string }).code === "ENOENT") return { status: "skipped" }
        const err = e as { stdout?: string; stderr?: string; message?: string }
        const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || ""
        return { status: "fail", tail: combined.slice(-TAIL_BYTES) }
    }
}

/**
 * Run the detected build/test commands at `cwd` (the merged branch), best-effort.
 * Runs every detectable command even if an earlier one fails, so the PR body can
 * surface all the problems at once.
 */
export async function verifyBuild(cwd: string): Promise<VerifyResult> {
    const failures: Array<{ cmd: string; tail: string }> = []
    let ran = false
    for (const c of detectCommands(cwd)) {
        const outcome = await runCmd(cwd, c)
        if (outcome.status === "skipped") continue
        ran = true
        if (outcome.status === "fail") failures.push({ cmd: c.label, tail: outcome.tail })
    }
    return { ran, ok: failures.length === 0, failures }
}
