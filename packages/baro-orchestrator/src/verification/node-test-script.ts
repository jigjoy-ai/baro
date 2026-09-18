/**
 * A declared/detected `npm run <script>` command whose script is itself a
 * `node --test` invocation runs its own glob resolution; appending PRD-focused
 * files to it produces extra file-group invocations instead of one run.
 * Coalescing bypasses the npm wrapper and calls node directly, once, with
 * every declared file merged in.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { javascriptCommandDetails, type VerifyCommandSpec } from "./verify.js"

interface NodeTestPackageManifest {
    scripts?: Record<string, unknown>
}

export type ReadPackageJson = (
    cwd: string | undefined,
) => NodeTestPackageManifest | null

function defaultReadPackageJson(cwd: string | undefined): NodeTestPackageManifest | null {
    if (cwd === undefined) return null
    const path = join(cwd, "package.json")
    if (!existsSync(path)) return null
    try {
        return JSON.parse(readFileSync(path, "utf8")) as NodeTestPackageManifest
    } catch {
        return null
    }
}

// package.json script values use literal shell-style quoting for globs
// (e.g. "test/**/*.test.ts") without ever being handed to a shell.
function tokenizeScriptValue(value: string): string[] {
    const tokens: string[] = []
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? "")
    }
    return tokens
}

interface ParsedNodeTestScript {
    /** Every non-`--test`, non-glob token, with a hardcoded `--import tsx` pair stripped. */
    otherFlags: readonly string[]
    globs: readonly string[]
}

function parseNodeTestScript(tokens: readonly string[]): ParsedNodeTestScript | null {
    if (tokens[0] !== "node") return null
    const testIndex = tokens.indexOf("--test", 1)
    if (testIndex < 0) return null
    const flags = [...tokens.slice(1, testIndex)]
    const globs: string[] = []
    for (const token of tokens.slice(testIndex + 1)) {
        if (token.startsWith("-")) flags.push(token)
        else globs.push(token)
    }
    if (globs.length === 0) return null
    const otherFlags: string[] = []
    for (let i = 0; i < flags.length; i++) {
        if (flags[i] === "--import" && flags[i + 1] === "tsx") {
            i += 1
            continue
        }
        otherFlags.push(flags[i]!)
    }
    return { otherFlags, globs }
}

interface NodeTestGroup {
    cwd: string | undefined
    script: string
    parsed: ParsedNodeTestScript
    files: Set<string>
    /** False once any member is a run-level (non-declared) command. */
    allDeclared: boolean
}

/**
 * Replaces every `<manager> run <script>` command whose script is a
 * `node --test` invocation with one direct `node --import tsx --test`
 * invocation per (cwd, script), deduplicating declared focus files instead of
 * running one npm-wrapped file group per declaring story. Commands whose
 * script is not shaped like `node [flags] --test [flags] <globs>` are
 * returned unchanged.
 */
export function coalesceNodeTestScripts(
    commands: readonly VerifyCommandSpec[],
    readPackageJson: ReadPackageJson = defaultReadPackageJson,
): VerifyCommandSpec[] {
    const manifestCache = new Map<string, NodeTestPackageManifest | null>()
    const groups = new Map<string, NodeTestGroup>()
    const groupKeyByIndex = new Map<number, string>()

    commands.forEach((command, index) => {
        const details = javascriptCommandDetails(command)
        if (!details) return
        const cacheKey = command.cwd ?? "<root>"
        let manifest = manifestCache.get(cacheKey)
        if (manifest === undefined) {
            manifest = readPackageJson(command.cwd)
            manifestCache.set(cacheKey, manifest)
        }
        const scriptValue = manifest?.scripts?.[details.script]
        if (typeof scriptValue !== "string") return
        const parsed = parseNodeTestScript(tokenizeScriptValue(scriptValue))
        if (!parsed) return

        const key = JSON.stringify([cacheKey, details.script])
        let group = groups.get(key)
        if (!group) {
            group = {
                cwd: command.cwd,
                script: details.script,
                parsed,
                files: new Set(),
                allDeclared: true,
            }
            groups.set(key, group)
        }
        if (command.origin !== "declared") group.allDeclared = false
        if (details.trailingArgs[0] === "--") {
            for (const file of details.trailingArgs.slice(1)) group.files.add(file)
        }
        groupKeyByIndex.set(index, key)
    })

    if (groups.size === 0) return [...commands]

    const emitted = new Set<string>()
    const result: VerifyCommandSpec[] = []
    commands.forEach((command, index) => {
        const key = groupKeyByIndex.get(index)
        if (key === undefined) {
            result.push(command)
            return
        }
        if (emitted.has(key)) return
        emitted.add(key)
        const group = groups.get(key)!
        const files = group.files.size > 0
            ? [...group.files].sort()
            : [...group.parsed.globs]
        result.push({
            label: `node --test (${group.script})`,
            tool: "node",
            args: ["--import", "tsx", ...group.parsed.otherFlags, "--test", ...files],
            ...(group.cwd !== undefined ? { cwd: group.cwd } : {}),
            ...(group.allDeclared ? { origin: "declared" as const } : {}),
        })
    })
    return result
}
