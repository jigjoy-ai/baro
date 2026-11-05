/**
 * The agent's world shows the mechanisms that will judge it, at tool-call
 * granularity: a Claude Code hook acknowledges evidence capture on every
 * verification command, and refuses a write into another story's surface at
 * the write — not an hour later at the merge gate. The rule texts come from
 * the gate registry, so what the hook says and what the gate enforces are
 * the same object.
 *
 * The script is materialized per story instead of shipped: hooks passed via
 * an explicit --settings file are trusted, nothing lands in the worktree
 * (so no diff pollution), and the script's behavior is version-locked to
 * this orchestrator rather than to whatever bundle a machine has installed.
 */

import { execFileSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
    SHELL_SCRATCH_DIRNAME,
    shellContainmentRemedyLine,
    surfaceRemedyLines,
} from "../../execution/gate-registry.js"
import {
    GUARD_REFUSALS_FILE,
    publishCommandRefusal,
} from "../../execution/publish-guard.js"
import { shellContainmentHookSource } from "../../execution/shell-containment.js"

export interface StoryHookSurface {
    writes: readonly string[]
    ownedElsewhere: Readonly<Record<string, string>>
}

/** What the hook needs to judge a command; written beside surface.json. */
interface ContainmentSettings {
    /** Absent for a caller that cannot name it: the hook then trusts the
     * working directory Claude Code reports with the tool call. */
    worktreeRoot?: string
    collabCommand?: string
    collabCapability?: string
}

// The __name shim covers bundlers that wrap serialized functions with keepNames.
const HOOK_SCRIPT = `#!/usr/bin/env node
// Materialized by baro (hook-bridge.ts). A hook must never break the agent:
// every path ends in exit 0, and a malformed input is treated as no input.
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

${shellContainmentHookSource()}

const mode = process.argv[2]
let input = {}
try {
    input = JSON.parse(readFileSync(0, "utf8"))
} catch {
    process.exit(0)
}
const toolInput = input.tool_input ?? {}

if (mode === "post-bash") {
    const command = String(toolInput.command ?? "")
    const looksLikeVerification =
        /\\b(npm|pnpm|yarn)( run)? (test|check)\\b|\\bcargo (test|build)\\b|\\bgo test\\b|\\bpytest\\b|node .*--test\\b/.test(
            command,
        )
    if (looksLikeVerification) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext:
                    "[gate:evidence-capture] This command's output was captured automatically as verification evidence, bound to the current bytes. One shaped run suffices — do not re-run it to reformat, slice, or archive the output.",
            },
        }))
    }
    process.exit(0)
}

if (mode === "pre-bash") {
    const command = String(toolInput.command ?? "")
    const here = dirname(fileURLToPath(import.meta.url))
    const refuse = (reason) => {
        try {
            appendFileSync(
                join(here, "${GUARD_REFUSALS_FILE}"),
                JSON.stringify({ command, reason }) + "\\n",
            )
        } catch {}
        process.stdout.write(JSON.stringify({
            decision: "block",
            reason,
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        }))
        process.exit(0)
    }

    const publishCommandRefusal = ${publishCommandRefusal.toString()}
    const published = publishCommandRefusal(command)
    if (published) refuse(published)

    let containment
    try {
        containment = JSON.parse(
            readFileSync(join(here, "containment.json"), "utf8"),
        )
    } catch {
        process.exit(0)
    }
    const worktreeRoot =
        typeof containment.worktreeRoot === "string" && containment.worktreeRoot
            ? containment.worktreeRoot
            : typeof input.cwd === "string"
              ? input.cwd
              : ""
    if (!worktreeRoot) process.exit(0)
    let contained = null
    try {
        contained = shellContainmentRefusal(
            worktreeRoot,
            command,
            hookShellAccessContext(
                worktreeRoot,
                typeof containment.collabCommand === "string"
                    ? containment.collabCommand
                    : null,
            ),
        )
    } catch (error) {
        // Fail closed: a containment check that cannot run must not wave
        // every command through.
        contained = "shell containment could not check this command (" +
            String(error && error.message || error) + "); it was refused"
    }
    if (contained) {
        const shellContainmentRemedyLine = ${shellContainmentRemedyLine.toString()}
        refuse(
            contained +
                "\\n" +
                shellContainmentRemedyLine(
                    typeof containment.scratchDir === "string"
                        ? containment.scratchDir
                        : "${SHELL_SCRATCH_DIRNAME}",
                ),
        )
    }
    process.exit(0)
}

if (mode === "pre-write") {
    const here = dirname(fileURLToPath(import.meta.url))
    const target = String(toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? "")
    if (!target) process.exit(0)
    const deny = (reason) => {
        process.stdout.write(JSON.stringify({
            decision: "block",
            reason,
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        }))
        process.exit(0)
    }

    // A file write must stay inside the story's worktree, like its shell.
    let containment = null
    try {
        containment = JSON.parse(readFileSync(join(here, "containment.json"), "utf8"))
    } catch {}
    const root = containment && typeof containment.worktreeRoot === "string" && containment.worktreeRoot
        ? containment.worktreeRoot
        : typeof input.cwd === "string" ? input.cwd : ""
    if (root) {
        const real = (candidate) => {
            let probe = path.resolve(candidate)
            const rest = []
            for (;;) {
                try {
                    return path.join(fs.realpathSync(probe), ...rest.reverse())
                } catch {
                    const parent = path.dirname(probe)
                    if (parent === probe) return path.resolve(candidate)
                    rest.push(path.basename(probe))
                    probe = parent
                }
            }
        }
        const realRoot = real(root)
        const realTarget = real(path.resolve(root, target))
        if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
            deny(
                \`[gate:shell-containment] \${target} is outside your worktree (\${root}); writes there are refused. Write inside the worktree; scratch files go under \${containment && containment.scratchDir || ".baro-scratch"}/.\`,
            )
        }
    }

    let surface
    try {
        surface = JSON.parse(readFileSync(join(here, "surface.json"), "utf8"))
    } catch {
        process.exit(0)
    }
    const owner = Object.entries(surface.ownedElsewhere ?? {}).find(
        ([path]) => target === path || target.endsWith("/" + path),
    )
    if (owner) {
        deny([
            \`[gate:write-surface] \${owner[0]} belongs to story \${owner[1]}, which has not integrated yet. A diff touching it is refused at integration, however small and however right it is — this refusal now costs you one edit instead of the whole story at the gate.\`,
            ...surface.remedy,
        ].join("\\n"))
    }
    process.exit(0)
}

process.exit(0)
`

/**
 * Writes hook.mjs, surface.json and settings.json into `dir` and returns the
 * settings path for the CLI's --settings flag. Returns null for a story with
 * no declared surface — the Claude story agent then installs
 * materializePublishGuardHooks on its own.
 */
export function materializeStoryHooks(
    dir: string,
    surface: StoryHookSurface | undefined,
    collab: { command: string; capability: string },
    worktreeRoot?: string,
): string | null {
    if (!surface || surface.writes.length === 0) return null
    mkdirSync(dir, { recursive: true })
    writeSurfaceFile(dir, surface, collab)
    return writeHookSettings(dir, {
        ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
        collabCommand: collab.command,
        collabCapability: collab.capability,
    })
}

/**
 * A mid-flight surface revision (a released or claimed path) for a story whose
 * hook is already installed: the hook reads surface.json on every write, so
 * the boundary it enforces moves with the plan instead of staying at spawn.
 */
export function refreshStoryHookSurface(
    dir: string,
    surface: StoryHookSurface,
    collab: { command: string; capability: string },
): void {
    if (!existsSync(join(dir, "surface.json"))) return
    writeSurfaceFile(dir, surface, collab)
}

function writeSurfaceFile(
    dir: string,
    surface: StoryHookSurface,
    collab: { command: string; capability: string },
): void {
    const file = join(dir, "surface.json")
    const staged = `${file}.${process.pid}.tmp`
    writeFileSync(
        staged,
        JSON.stringify(
            {
                writes: surface.writes,
                ownedElsewhere: surface.ownedElsewhere,
                remedy: surfaceRemedyLines(collab.command, collab.capability),
            },
            null,
            2,
        ),
    )
    // Atomic swap: the hook may read it at any moment.
    renameSync(staged, file)
}

/**
 * Proves the hook refuses a command that leaves the worktree before any story
 * relies on it. The hook is serialized source, and a bundle once broke it so
 * that it allowed everything; a story must not start behind a guard that
 * does not hold.
 */
export function assertHookContainsShell(hookPath: string): void {
    // Probe a copy: the real hook records each refusal for its story.
    const probe = mkdtempSync(join(tmpdir(), "baro-hook-probe-"))
    const run = (command: string): string =>
        execFileSync(process.execPath, [join(probe, "hook.mjs"), "pre-bash"], {
            input: JSON.stringify({ tool_input: { command }, cwd: probe }),
            encoding: "utf8",
            timeout: 10_000,
        })
    let escaping = ""
    let inside = "unread"
    try {
        const dir = dirname(hookPath)
        copyFileSync(hookPath, join(probe, "hook.mjs"))
        copyFileSync(join(dir, "containment.json"), join(probe, "containment.json"))
        escaping = run("cd .. && ls")
        inside = run("ls")
    } finally {
        rmSync(probe, { recursive: true, force: true })
    }
    let refused = false
    try {
        const verdict = JSON.parse(escaping)
        refused =
            verdict.decision === "block" &&
            !String(verdict.reason).includes("could not check")
    } catch {
        refused = false
    }
    if (!refused || inside !== "") {
        throw new Error(
            `the story hook at ${hookPath} does not judge shell commands (it must refuse one that leaves the worktree and allow one inside it); refusing to start a story behind it`,
        )
    }
}

/** Publish and containment denial alone, for a story with no write surface. */
export function materializePublishGuardHooks(
    dir: string,
    worktreeRoot?: string,
): string {
    mkdirSync(dir, { recursive: true })
    return writeHookSettings(
        dir,
        worktreeRoot === undefined ? {} : { worktreeRoot },
    )
}

function writeHookSettings(
    dir: string,
    containment: ContainmentSettings,
): string {
    const hookPath = join(dir, "hook.mjs")
    writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 })
    writeFileSync(
        join(dir, "containment.json"),
        JSON.stringify(
            {
                worktreeRoot: containment.worktreeRoot ?? null,
                collabCommand: containment.collabCommand ?? null,
                collabCapability: containment.collabCapability ?? null,
                scratchDir: SHELL_SCRATCH_DIRNAME,
            },
            null,
            2,
        ),
    )
    assertHookContainsShell(hookPath)
    const settingsPath = join(dir, "settings.json")
    const hook = (mode: string) => ({
        hooks: [
            {
                type: "command",
                command: `node ${JSON.stringify(hookPath)} ${mode}`,
            },
        ],
    })
    writeFileSync(
        settingsPath,
        JSON.stringify(
            {
                hooks: {
                    PostToolUse: [{ ...hook("post-bash"), matcher: "Bash" }],
                    PreToolUse: [
                        // Always: containment applies to every story; the
                        // ownership half reads surface.json when there is one.
                        { ...hook("pre-write"), matcher: "Write|Edit|MultiEdit|NotebookEdit" },
                        { ...hook("pre-bash"), matcher: "Bash" },
                    ],
                },
            },
            null,
            2,
        ),
    )
    return settingsPath
}
