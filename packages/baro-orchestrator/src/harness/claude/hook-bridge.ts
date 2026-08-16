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

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { surfaceRemedyLines } from "../../execution/gate-registry.js"

export interface StoryHookSurface {
    writes: readonly string[]
    ownedElsewhere: Readonly<Record<string, string>>
}

const HOOK_SCRIPT = `#!/usr/bin/env node
// Materialized by baro (hook-bridge.ts). A hook must never break the agent:
// every path ends in exit 0, and a malformed input is treated as no input.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

if (mode === "pre-write") {
    let surface
    try {
        const here = dirname(fileURLToPath(import.meta.url))
        surface = JSON.parse(readFileSync(join(here, "surface.json"), "utf8"))
    } catch {
        process.exit(0)
    }
    const target = String(toolInput.file_path ?? toolInput.path ?? "")
    if (!target) process.exit(0)
    const owner = Object.entries(surface.ownedElsewhere ?? {}).find(
        ([path]) => target === path || target.endsWith("/" + path),
    )
    if (owner) {
        const reason = [
            \`[gate:write-surface] \${owner[0]} belongs to story \${owner[1]} in this run. A diff touching it is refused at integration, however small and however right it is — this refusal now costs you one edit instead of the whole story at the gate.\`,
            ...surface.remedy,
        ].join("\\n")
        process.stdout.write(JSON.stringify({
            decision: "block",
            reason,
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        }))
    }
    process.exit(0)
}

process.exit(0)
`

/**
 * Writes hook.mjs, surface.json and settings.json into `dir` and returns the
 * settings path for the CLI's --settings flag. Returns null for a story with
 * no declared surface — a hook that guards nothing is noise.
 */
export function materializeStoryHooks(
    dir: string,
    surface: StoryHookSurface | undefined,
    collab: { command: string; capability: string },
): string | null {
    if (!surface || surface.writes.length === 0) return null
    mkdirSync(dir, { recursive: true })
    const hookPath = join(dir, "hook.mjs")
    writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 })
    writeFileSync(
        join(dir, "surface.json"),
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
    const settingsPath = join(dir, "settings.json")
    const hook = (mode: string) => [
        {
            hooks: [
                {
                    type: "command",
                    command: `node ${JSON.stringify(hookPath)} ${mode}`,
                },
            ],
        },
    ]
    writeFileSync(
        settingsPath,
        JSON.stringify(
            {
                hooks: {
                    PostToolUse: [
                        { ...hook("post-bash")[0], matcher: "Bash" },
                    ],
                    PreToolUse: [
                        {
                            ...hook("pre-write")[0],
                            matcher: "Write|Edit|MultiEdit",
                        },
                    ],
                },
            },
            null,
            2,
        ),
    )
    return settingsPath
}
