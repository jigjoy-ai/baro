import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import type { CompleteMetricTotal } from "../src/benchmark-metrics.js"

export interface FrozenVerificationInput {
    path: string
    sha256: string
    sizeBytes: number
    discoveredFrom: "explicit" | "verify_command"
}

export interface FreezeVerificationInputOptions {
    explicitPaths: readonly string[]
    verifyCommands: readonly string[]
    launchCwd: string
}

/** Tracks whether each durable story-attempt lifecycle saw any terminal usage. */
export class StoryAttemptCoverageTracker {
    private readonly active = new Map<string, boolean>()
    private measuredCount = 0
    private unmeasuredCount = 0

    start(storyId: string): void {
        this.finish(storyId)
        this.active.set(storyId, false)
    }

    measured(storyId: string): void {
        if (this.active.has(storyId)) this.active.set(storyId, true)
    }

    finish(storyId: string): void {
        const measured = this.active.get(storyId)
        if (measured === undefined) return
        if (measured) this.measuredCount++
        else this.unmeasuredCount++
        this.active.delete(storyId)
    }

    finishAll(): void {
        for (const storyId of [...this.active.keys()]) this.finish(storyId)
    }

    get attemptsWithMeasurement(): number {
        return this.measuredCount
    }

    get attemptsWithoutMeasurement(): number {
        return this.unmeasuredCount
    }
}

function sha256(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex")
}

/**
 * Split enough of POSIX shell syntax to find literal file arguments without
 * evaluating the command. Dynamic expansions are intentionally left in the
 * token and ignored by the caller; --verify-input covers those cases.
 */
function literalShellWords(command: string): string[] {
    const words: string[] = []
    let word = ""
    let quote: "'" | '"' | null = null
    let escaped = false

    const flush = (): void => {
        if (word) words.push(word)
        word = ""
    }

    for (let index = 0; index < command.length; index++) {
        const char = command[index]!
        if (escaped) {
            word += char
            escaped = false
            continue
        }
        if (char === "\\" && quote !== "'") {
            escaped = true
            continue
        }
        if (quote) {
            if (char === quote) quote = null
            else word += char
            continue
        }
        if (char === "'" || char === '"') {
            quote = char
            continue
        }
        if (/\s/.test(char)) {
            flush()
            continue
        }
        if (";&|<>()".includes(char)) {
            flush()
            let operator = char
            const next = command[index + 1]
            if (next === char && (char === "&" || char === "|" || char === ">")) {
                operator += next
                index++
            }
            words.push(operator)
            continue
        }
        word += char
    }
    if (escaped) word += "\\"
    flush()
    return words
}

function literalAbsoluteFileArguments(command: string): string[] {
    const paths: string[] = []
    let commandPosition = true

    for (const word of literalShellWords(command)) {
        if ([";", "&&", "||", "|", "&"].includes(word)) {
            commandPosition = true
            continue
        }
        if ([">", ">>", "<", "(", ")"].includes(word)) continue

        // Do not hash an absolute executable used as the command. The evidence
        // is for external verifier inputs; platform/runtime versions are
        // already recorded separately in the experiment manifest.
        if (commandPosition) {
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
            commandPosition = false
            continue
        }

        if (/[`$*?\[]/.test(word)) continue
        const candidate = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word
        if (isAbsolute(candidate)) paths.push(candidate)
    }
    return paths
}

function freezePath(
    requestedPath: string,
    launchCwd: string,
    discoveredFrom: FrozenVerificationInput["discoveredFrom"],
): FrozenVerificationInput {
    const candidate = resolve(launchCwd, requestedPath)
    if (!existsSync(candidate)) {
        throw new Error(`verification input does not exist: ${candidate}`)
    }
    const path = realpathSync(candidate)
    const stat = statSync(path)
    if (!stat.isFile()) {
        throw new Error(`verification input is not a regular file: ${path}`)
    }
    return {
        path,
        sha256: sha256(readFileSync(path)),
        sizeBytes: stat.size,
        discoveredFrom,
    }
}

/** Freeze explicit inputs plus literal absolute files referenced by verifiers. */
export function freezeVerificationInputs(
    options: FreezeVerificationInputOptions,
): FrozenVerificationInput[] {
    const byPath = new Map<string, FrozenVerificationInput>()

    for (const requestedPath of options.explicitPaths) {
        const input = freezePath(requestedPath, options.launchCwd, "explicit")
        byPath.set(input.path, input)
    }
    for (const command of options.verifyCommands) {
        for (const requestedPath of literalAbsoluteFileArguments(command)) {
            if (!existsSync(requestedPath) || !statSync(requestedPath).isFile()) continue
            const input = freezePath(requestedPath, options.launchCwd, "verify_command")
            if (!byPath.has(input.path)) byPath.set(input.path, input)
        }
    }

    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function verificationInputsFingerprint(
    inputs: readonly FrozenVerificationInput[],
): string {
    const hash = createHash("sha256")
    for (const input of inputs) {
        hash.update(input.path).update("\0")
        hash.update(input.sha256).update("\0")
        hash.update(String(input.sizeBytes)).update("\0")
    }
    return hash.digest("hex")
}

/** Check the exact frozen bytes before/after each arm without throwing. */
export function verificationInputsMatch(
    inputs: readonly FrozenVerificationInput[],
): boolean {
    try {
        return inputs.every((input) => {
            if (!existsSync(input.path)) return false
            const stat = statSync(input.path)
            return stat.isFile() &&
                stat.size === input.sizeBytes &&
                sha256(readFileSync(input.path)) === input.sha256
        })
    } catch {
        return false
    }
}

/** Add lifecycle-observed attempts that produced no terminal model record. */
export function includeUnmeasuredAttempts(
    total: CompleteMetricTotal,
    unmeasuredAttempts: number,
): CompleteMetricTotal {
    if (!Number.isSafeInteger(unmeasuredAttempts) || unmeasuredAttempts < 0) {
        throw new RangeError("unmeasuredAttempts must be a non-negative safe integer")
    }
    if (unmeasuredAttempts === 0) return total
    return {
        value: null,
        known: total.known,
        unknown: total.unknown + unmeasuredAttempts,
        notApplicable: total.notApplicable,
        total: total.total + unmeasuredAttempts,
    }
}
