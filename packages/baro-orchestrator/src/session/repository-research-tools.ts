import { Buffer } from "node:buffer"
import {
    closeSync,
    constants,
    type Dirent,
    fstatSync,
    lstatSync,
    openSync,
    readSync,
    realpathSync,
    statSync,
} from "node:fs"
import { opendir } from "node:fs/promises"
import {
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import type { Tool } from "@mozaik-ai/core"

import { validateRepositoryEvidencePath } from "./repository-brief.js"
import {
    repositoryDirectoryIsIgnored,
    repositoryPathIsSensitive,
    repositoryTextPathIsEligible,
} from "./repository-scanner.js"

export const MAX_REPOSITORY_SEARCH_PATTERN_LENGTH = 1_000
export const MAX_REPOSITORY_GLOB_PATTERN_LENGTH = 512

const MAX_READ_FILE_BYTES = 500 * 1024
const MAX_READ_OUTPUT_BYTES = 15 * 1024
const MAX_SEARCH_VISITS = 50_000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_SEARCH_LINES = 80
const MAX_SEARCH_LINE_CHARS = 1_000
const MAX_GLOB_VISITS = 50_000
const MAX_GLOB_RESULTS = 200
const MAX_GLOB_MATCH_WORK = 2_000_000
const COOPERATIVE_YIELD_WORK = 64
const MAX_DIRECTORY_COLLECTION_ENTRIES = 10_000
const GLOB_DP_CHECKPOINT_WORK = 4_096

export const ABORTABLE_REPOSITORY_TOOL_INVOKE: unique symbol = Symbol(
    "baro.abortableRepositoryToolInvoke",
)

export interface RepositoryToolInvocationContext {
    readonly signal: AbortSignal
    /** Absolute epoch millisecond deadline, when the caller owns one. */
    readonly deadlineMs?: number
    /** Provider-free diagnostic seam used to prove traversal has stopped. */
    readonly onCooperativeYield?: () => void
    /** Provider-free seam for proving one directory cannot bypass visit bounds. */
    readonly maxDirectoryEntries?: number
}

interface AbortableRepositoryTool extends Tool {
    [ABORTABLE_REPOSITORY_TOOL_INVOKE](
        args: Record<string, string>,
        context: RepositoryToolInvocationContext,
    ): Promise<unknown>
}

interface TraversalControl extends RepositoryToolInvocationContext {
    workSinceYield: number
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal

/**
 * Use the cancellation-aware built-in path when available while preserving
 * compatibility with injected generic Mozaik Tools.
 */
export async function invokeRepositoryResearchTool(
    tool: Tool,
    args: Record<string, string>,
    context: RepositoryToolInvocationContext,
): Promise<unknown> {
    throwIfTraversalCancelled(context)
    const abortable = tool as Partial<AbortableRepositoryTool>
    const invoke = abortable[ABORTABLE_REPOSITORY_TOOL_INVOKE]
    const result = typeof invoke === "function"
        ? await invoke.call(tool, args, context)
        : await tool.invoke(args)
    throwIfTraversalCancelled(context)
    return result
}

function traversalControl(
    context: RepositoryToolInvocationContext,
): TraversalControl {
    if (
        !context.signal ||
        typeof context.signal.aborted !== "boolean" ||
        (context.deadlineMs !== undefined && !Number.isFinite(context.deadlineMs)) ||
        (
            context.maxDirectoryEntries !== undefined &&
            (
                !Number.isSafeInteger(context.maxDirectoryEntries) ||
                context.maxDirectoryEntries < 1 ||
                context.maxDirectoryEntries > MAX_SEARCH_VISITS
            )
        )
    ) throw new TypeError("repository tool invocation context is invalid")
    throwIfTraversalCancelled(context)
    return { ...context, workSinceYield: 0 }
}

function throwIfTraversalCancelled(
    context: RepositoryToolInvocationContext,
): void {
    if (context.signal.aborted) {
        const reason: unknown = context.signal.reason
        if (reason instanceof Error) throw reason
        const error = new Error("repository research tool aborted")
        error.name = "AbortError"
        throw error
    }
    if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) {
        const error = new Error("repository research tool deadline exceeded")
        error.name = "TimeoutError"
        throw error
    }
}

async function cooperativeCheckpoint(
    control: TraversalControl,
    work = 1,
    forceYield = false,
): Promise<void> {
    throwIfTraversalCancelled(control)
    control.workSinceYield += Math.max(1, work)
    if (!forceYield && control.workSinceYield < COOPERATIVE_YIELD_WORK) return
    control.workSinceYield = 0
    control.onCooperativeYield?.()
    await yieldToEventLoop()
    throwIfTraversalCancelled(control)
}

/**
 * Dedicated capability broker for autonomous repository research.
 * It intentionally has no shell, write, process, network, git or arbitrary
 * filesystem tool. Sensitive paths and every symlink are excluded.
 */
export function createReadOnlyRepositoryScoutTools(root: string): Tool[] {
    const canonicalRoot = realpathSync(resolve(root))
    if (!statSync(canonicalRoot).isDirectory()) {
        throw new TypeError("repository scout root must be a directory")
    }
    const invokeRead = async (
        args: Record<string, string>,
        context: RepositoryToolInvocationContext,
    ): Promise<string> => {
        const control = traversalControl(context)
        await cooperativeCheckpoint(control)
        let path: string
        try {
            path = validateInspectableRepositoryEvidencePath(args.path)
        } catch {
            return "Error: file path is unsafe, sensitive, or not an eligible text file."
        }
        const absolute = containedExistingPath(canonicalRoot, path)
        if (!absolute) return `Error: file path '${path}' is unavailable or linked.`
        const content = await readContainedTextFile(
            canonicalRoot,
            absolute,
            MAX_READ_FILE_BYTES,
            control,
        )
        if (content === null) return `Error: file '${path}' is unavailable or not text.`
        return clipUtf8(content, MAX_READ_OUTPUT_BYTES)
    }
    const read: AbortableRepositoryTool = {
        type: "function",
        name: "read_file",
        description: "Read one non-sensitive text file inside the repository.",
        strict: true,
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
        },
        invoke(args: { path: string }) {
            return invokeRead(args, { signal: NEVER_ABORTED_SIGNAL })
        },
        [ABORTABLE_REPOSITORY_TOOL_INVOKE]: invokeRead,
    }
    const invokeSearch = async (
        args: Record<string, string>,
        context: RepositoryToolInvocationContext,
    ): Promise<string> => {
        const control = traversalControl(context)
        await cooperativeCheckpoint(control)
        let pattern: string
        let searchPath: string
        let filePattern: string
        try {
            pattern = validateRepositorySearchPattern(args.pattern)
            searchPath = args.path === ""
                ? ""
                : validateRepositoryResearchDirectoryPath(args.path)
            filePattern = args.file_pattern === ""
                ? ""
                : validateRepositoryGlobPattern(args.file_pattern)
        } catch {
            return "Error: search arguments are unsafe or sensitive."
        }
        const absolute = searchPath === ""
            ? canonicalRoot
            : containedExistingPath(canonicalRoot, searchPath)
        if (!absolute) return "Error: search path is unavailable or linked."
        return await literalRepositorySearch(
            canonicalRoot,
            absolute,
            pattern,
            filePattern,
            control,
        )
    }
    const search: AbortableRepositoryTool = {
        type: "function",
        name: "grep",
        description: "Search literal text in non-sensitive repository text files.",
        strict: true,
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string" },
                path: { type: "string" },
                file_pattern: { type: "string" },
            },
            required: ["pattern", "path", "file_pattern"],
            additionalProperties: false,
        },
        invoke(args: {
            pattern: string
            path: string
            file_pattern: string
        }) {
            return invokeSearch(args, { signal: NEVER_ABORTED_SIGNAL })
        },
        [ABORTABLE_REPOSITORY_TOOL_INVOKE]: invokeSearch,
    }
    const invokeGlob = async (
        args: Record<string, string>,
        context: RepositoryToolInvocationContext,
    ): Promise<string> => {
        const control = traversalControl(context)
        await cooperativeCheckpoint(control)
        let pattern: string
        try {
            pattern = validateRepositoryGlobPattern(args.pattern)
        } catch {
            return "Error: glob pattern is unsafe."
        }
        return await safeRepositoryGlob(canonicalRoot, pattern, control)
    }
    const glob: AbortableRepositoryTool = {
        type: "function",
        name: "glob",
        description: "List non-sensitive repository text files matching a bounded glob.",
        strict: true,
        parameters: {
            type: "object",
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
            additionalProperties: false,
        },
        invoke(args: { pattern: string }) {
            return invokeGlob(args, { signal: NEVER_ABORTED_SIGNAL })
        },
        [ABORTABLE_REPOSITORY_TOOL_INVOKE]: invokeGlob,
    }
    return [read, search, glob]
}

export function validateInspectableRepositoryEvidencePath(value: unknown): string {
    const path = validateRepositoryEvidencePath(value)
    if (
        repositoryPathIsSensitive(path) ||
        repositoryPathContainsIgnoredDirectory(path) ||
        !repositoryTextPathIsEligible(path)
    ) {
        throw new TypeError("repository path is excluded")
    }
    return path
}

export function validateRepositoryResearchDirectoryPath(value: unknown): string {
    const path = validateRepositoryEvidencePath(value)
    if (
        repositoryPathIsSensitive(path) ||
        repositoryPathContainsIgnoredDirectory(path)
    ) {
        throw new TypeError("repository directory is excluded")
    }
    return path
}

function repositoryPathContainsIgnoredDirectory(path: string): boolean {
    return path.split("/").some(repositoryDirectoryIsIgnored)
}

export function validateRepositorySearchPattern(value: unknown): string {
    return boundedToolText(
        value,
        MAX_REPOSITORY_SEARCH_PATTERN_LENGTH,
        "search pattern",
    )
}

export function validateRepositoryGlobPattern(value: unknown): string {
    const pattern = boundedToolText(
        value,
        MAX_REPOSITORY_GLOB_PATTERN_LENGTH,
        "glob pattern",
    ).replace(/^\.\//u, "")
    if (
        pattern.startsWith("/") ||
        /^[A-Za-z]:/u.test(pattern) ||
        pattern.includes("\\") ||
        pattern.split("/").some((segment) => segment === "." || segment === "..")
    ) throw new TypeError("glob pattern is unsafe")
    return pattern
}

function containedExistingPath(root: string, relativePath: string): string | null {
    const absolute = resolve(root, relativePath)
    if (!pathIsWithin(root, absolute) || pathContainsSymlink(root, absolute)) return null
    try {
        const canonical = realpathSync(absolute)
        if (!pathIsWithin(root, canonical)) return null
        const metadata = lstatSync(absolute)
        if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
            return null
        }
        return canonical
    } catch {
        return null
    }
}

function pathContainsSymlink(root: string, absolute: string): boolean {
    const fromRoot = relative(root, absolute)
    if (fromRoot === "") return false
    let current = root
    for (const segment of fromRoot.split(sep)) {
        current = join(current, segment)
        try {
            if (lstatSync(current).isSymbolicLink()) return true
        } catch {
            return true
        }
    }
    return false
}

function pathIsWithin(root: string, candidate: string): boolean {
    const fromRoot = relative(root, candidate)
    return fromRoot === "" || (
        fromRoot !== ".." &&
        !fromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(fromRoot)
    )
}

async function readContainedTextFile(
    root: string,
    absolute: string,
    maximumBytes: number,
    control: TraversalControl,
): Promise<string | null> {
    await cooperativeCheckpoint(control)
    if (!pathIsWithin(root, absolute) || pathContainsSymlink(root, absolute)) return null
    let descriptor: number | null = null
    try {
        descriptor = openSync(
            absolute,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        )
        const metadata = fstatSync(descriptor)
        if (!metadata.isFile() || metadata.size > maximumBytes) return null
        const bytes = Buffer.alloc(metadata.size)
        let offset = 0
        while (offset < bytes.length) {
            const count = readSync(
                descriptor,
                bytes,
                offset,
                Math.min(64 * 1024, bytes.length - offset),
                null,
            )
            if (count === 0) return null
            offset += count
            await cooperativeCheckpoint(control, 1, true)
        }
        throwIfTraversalCancelled(control)
        if (fstatSync(descriptor).size !== metadata.size || looksBinary(bytes)) return null
        return bytes.toString("utf8")
    } catch {
        throwIfTraversalCancelled(control)
        return null
    } finally {
        if (descriptor !== null) closeSync(descriptor)
    }
}

interface DirectoryEntriesResult {
    readonly entries: readonly Dirent[]
    readonly limited: boolean
}

async function readDirectoryEntries(
    absolute: string,
    maximumEntries: number,
    control: TraversalControl,
): Promise<DirectoryEntriesResult | null> {
    let directory: Awaited<ReturnType<typeof opendir>> | null = null
    try {
        directory = await opendir(absolute)
        const entries: Dirent[] = []
        while (entries.length < maximumEntries) {
            const entry = await directory.read()
            if (entry === null) {
                return {
                    entries: await cooperativelySorted(
                        entries,
                        (left, right) => left.name.localeCompare(right.name, "en"),
                        control,
                    ),
                    limited: false,
                }
            }
            entries.push(entry)
            await cooperativeCheckpoint(control)
        }
        // Probe one extra entry without retaining it. This distinguishes an
        // exactly-full directory from omitted evidence while keeping memory
        // bounded by `maximumEntries`.
        const limited = await directory.read() !== null
        return {
            entries: await cooperativelySorted(
                entries,
                (left, right) => left.name.localeCompare(right.name, "en"),
                control,
            ),
            limited,
        }
    } catch {
        throwIfTraversalCancelled(control)
        return null
    } finally {
        if (directory !== null) {
            await directory.close().catch(() => undefined)
        }
    }
}

function directoryCollectionBudget(
    remainingVisits: number,
    control: TraversalControl,
): number {
    return Math.max(
        1,
        Math.min(
            remainingVisits,
            control.maxDirectoryEntries ?? MAX_DIRECTORY_COLLECTION_ENTRIES,
        ),
    )
}

async function cooperativelySorted<T>(
    values: readonly T[],
    compare: (left: T, right: T) => number,
    control: TraversalControl,
): Promise<T[]> {
    if (values.length < 2) return [...values]
    let source = [...values]
    let target = new Array<T>(source.length)
    for (let width = 1; width < source.length; width *= 2) {
        for (let start = 0; start < source.length; start += width * 2) {
            const middle = Math.min(start + width, source.length)
            const end = Math.min(start + width * 2, source.length)
            let left = start
            let right = middle
            let output = start
            while (left < middle || right < end) {
                await cooperativeCheckpoint(control)
                if (
                    right >= end ||
                    (left < middle && compare(source[left]!, source[right]!) <= 0)
                ) {
                    target[output] = source[left]!
                    left += 1
                } else {
                    target[output] = source[right]!
                    right += 1
                }
                output += 1
            }
        }
        ;[source, target] = [target, source]
    }
    return source
}

async function literalRepositorySearch(
    root: string,
    searchRoot: string,
    pattern: string,
    filePattern: string,
    control: TraversalControl,
): Promise<string> {
    const needle = pattern.toLocaleLowerCase("en")
    const fileMatcher = filePattern ? compileGlobMatcher(filePattern, control) : null
    const matches: string[] = []
    let visits = 0
    let bytesRead = 0
    let truncated = false

    const visitFile = async (absolute: string): Promise<void> => {
        await cooperativeCheckpoint(control)
        if (
            matches.length >= MAX_SEARCH_LINES ||
            visits >= MAX_SEARCH_VISITS ||
            bytesRead >= MAX_SEARCH_TOTAL_BYTES
        ) {
            truncated = true
            return
        }
        const path = relative(root, absolute).split(sep).join("/")
        if (repositoryPathIsSensitive(path) || !repositoryTextPathIsEligible(path)) return
        if (fileMatcher) {
            const basename = path.split("/").at(-1) ?? path
            const matched = await fileMatcher.matches(path) ||
                await fileMatcher.matches(basename)
            if (fileMatcher.exhausted) {
                truncated = true
                return
            }
            if (!matched) return
        }
        let size: number
        try {
            size = lstatSync(absolute).size
        } catch {
            throwIfTraversalCancelled(control)
            return
        }
        if (size > MAX_SEARCH_FILE_BYTES || bytesRead + size > MAX_SEARCH_TOTAL_BYTES) {
            truncated = true
            return
        }
        const content = await readContainedTextFile(
            root,
            absolute,
            MAX_SEARCH_FILE_BYTES,
            control,
        )
        if (content === null) return
        bytesRead += Buffer.byteLength(content, "utf8")
        const lines = content.split(/\r?\n/u)
        for (let index = 0; index < lines.length; index += 1) {
            await cooperativeCheckpoint(control)
            const line = lines[index]!
            if (!line.toLocaleLowerCase("en").includes(needle)) continue
            matches.push(`${path}:${index + 1}:${clipText(line, MAX_SEARCH_LINE_CHARS)}`)
            if (matches.length >= MAX_SEARCH_LINES) {
                truncated = true
                return
            }
        }
    }

    const walk = async (absolute: string): Promise<void> => {
        await cooperativeCheckpoint(control)
        if (
            visits >= MAX_SEARCH_VISITS ||
            matches.length >= MAX_SEARCH_LINES ||
            fileMatcher?.exhausted
        ) {
            truncated = true
            return
        }
        if (!pathIsWithin(root, absolute) || pathContainsSymlink(root, absolute)) return
        let metadata
        try {
            metadata = lstatSync(absolute)
        } catch {
            throwIfTraversalCancelled(control)
            return
        }
        if (metadata.isSymbolicLink()) return
        if (metadata.isFile()) {
            visits += 1
            await visitFile(absolute)
            return
        }
        if (!metadata.isDirectory()) return
        if (!containedDirectory(root, absolute)) return
        const directory = await readDirectoryEntries(
            absolute,
            directoryCollectionBudget(MAX_SEARCH_VISITS - visits, control),
            control,
        )
        if (directory === null) return
        if (directory.limited) truncated = true
        for (const entry of directory.entries) {
            await cooperativeCheckpoint(control)
            visits += 1
            if (visits > MAX_SEARCH_VISITS) {
                truncated = true
                return
            }
            if (entry.isSymbolicLink() || repositoryDirectoryIsIgnored(entry.name)) continue
            const child = join(absolute, entry.name)
            const path = relative(root, child).split(sep).join("/")
            if (repositoryPathIsSensitive(path)) continue
            if (entry.isDirectory()) await walk(child)
            else if (entry.isFile()) await visitFile(child)
            if (matches.length >= MAX_SEARCH_LINES || fileMatcher?.exhausted) return
        }
    }

    await walk(searchRoot)
    const note = truncated ? "\n... (search limit reached)" : ""
    return matches.length > 0
        ? matches.join("\n") + note
        : truncated
          ? "No matches found before the search limit was reached."
          : "No matches found."
}

async function safeRepositoryGlob(
    root: string,
    pattern: string,
    control: TraversalControl,
): Promise<string> {
    const results: string[] = []
    const matcher = compileGlobMatcher(pattern, control)
    let visits = 0
    let truncated = false
    const walk = async (absolute: string): Promise<void> => {
        await cooperativeCheckpoint(control)
        if (
            visits >= MAX_GLOB_VISITS ||
            results.length >= MAX_GLOB_RESULTS ||
            matcher.exhausted
        ) {
            truncated = true
            return
        }
        if (!containedDirectory(root, absolute)) return
        const directory = await readDirectoryEntries(
            absolute,
            directoryCollectionBudget(MAX_GLOB_VISITS - visits, control),
            control,
        )
        if (directory === null) return
        if (directory.limited) truncated = true
        for (const entry of directory.entries) {
            await cooperativeCheckpoint(control)
            visits += 1
            if (visits > MAX_GLOB_VISITS) {
                truncated = true
                return
            }
            if (entry.isSymbolicLink() || repositoryDirectoryIsIgnored(entry.name)) continue
            const child = join(absolute, entry.name)
            const path = relative(root, child).split(sep).join("/")
            if (repositoryPathIsSensitive(path)) continue
            if (entry.isDirectory()) await walk(child)
            else if (
                entry.isFile() &&
                repositoryTextPathIsEligible(path) &&
                await matcher.matches(path)
            ) {
                results.push(path)
            }
            if (matcher.exhausted) truncated = true
            if (results.length >= MAX_GLOB_RESULTS || matcher.exhausted) {
                truncated = true
                return
            }
        }
    }
    await walk(root)
    if (results.length === 0) {
        return truncated
            ? "(no matches before glob work limit was reached)"
            : "(no matches)"
    }
    return results.join("\n") + (truncated ? "\n... (glob limit reached)" : "")
}

function containedDirectory(root: string, absolute: string): boolean {
    if (!pathIsWithin(root, absolute) || pathContainsSymlink(root, absolute)) return false
    try {
        return lstatSync(absolute).isDirectory() &&
            pathIsWithin(root, realpathSync(absolute))
    } catch {
        return false
    }
}

interface CompiledGlobMatcher {
    matches(path: string): Promise<boolean>
    readonly exhausted: boolean
}

interface GlobWorkBudget {
    remaining: number
    sinceCheckpoint: number
}

/** Two-row DP plus one cumulative per-invocation work budget. */
function compileGlobMatcher(
    pattern: string,
    control: TraversalControl,
): CompiledGlobMatcher {
    const patternSegments = pattern.split("/")
    const budget: GlobWorkBudget = {
        remaining: MAX_GLOB_MATCH_WORK,
        sinceCheckpoint: 0,
    }
    return {
        async matches(path: string): Promise<boolean> {
            if (budget.remaining <= 0) return false
            const pathSegments = path.split("/")
            const memo = new Map<string, boolean>()
            const match = async (
                patternIndex: number,
                pathIndex: number,
            ): Promise<boolean> => {
                if (!consumeGlobWork(budget)) return false
                await checkpointGlobWork(budget, control)
                const key = `${patternIndex}:${pathIndex}`
                const known = memo.get(key)
                if (known !== undefined) return known
                let result: boolean
                if (patternIndex === patternSegments.length) {
                    result = pathIndex === pathSegments.length
                } else if (patternSegments[patternIndex] === "**") {
                    result = await match(patternIndex + 1, pathIndex)
                    if (!result && pathIndex < pathSegments.length) {
                        result = await match(patternIndex, pathIndex + 1)
                    }
                } else {
                    result = pathIndex < pathSegments.length &&
                        await matchSegment(
                            patternSegments[patternIndex]!,
                            pathSegments[pathIndex]!,
                            budget,
                            control,
                        ) &&
                        await match(patternIndex + 1, pathIndex + 1)
                }
                memo.set(key, result)
                return result
            }
            return await match(0, 0)
        },
        get exhausted(): boolean {
            return budget.remaining <= 0
        },
    }
}

async function matchSegment(
    pattern: string,
    value: string,
    budget: GlobWorkBudget,
    control: TraversalControl,
): Promise<boolean> {
    let previous = new Uint8Array(value.length + 1)
    let current = new Uint8Array(value.length + 1)
    previous[0] = 1
    for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex += 1) {
        current.fill(0)
        const token = pattern[patternIndex - 1]!
        if (token === "*") current[0] = previous[0]!
        for (let valueIndex = 1; valueIndex <= value.length; valueIndex += 1) {
            if (!consumeGlobWork(budget)) return false
            if (budget.sinceCheckpoint >= GLOB_DP_CHECKPOINT_WORK) {
                await checkpointGlobWork(budget, control)
            }
            current[valueIndex] = token === "*"
                ? Number(Boolean(previous[valueIndex] || current[valueIndex - 1]))
                : (token === "?" || token === value[valueIndex - 1]) &&
                    Boolean(previous[valueIndex - 1])
                  ? 1
                  : 0
        }
        ;[previous, current] = [current, previous]
    }
    return previous[value.length] === 1
}

function consumeGlobWork(budget: GlobWorkBudget): boolean {
    if (budget.remaining <= 0) return false
    budget.remaining -= 1
    budget.sinceCheckpoint += 1
    return true
}

async function checkpointGlobWork(
    budget: GlobWorkBudget,
    control: TraversalControl,
): Promise<void> {
    if (budget.sinceCheckpoint < GLOB_DP_CHECKPOINT_WORK) return
    const completed = budget.sinceCheckpoint
    budget.sinceCheckpoint = 0
    await cooperativeCheckpoint(control, completed, true)
}

function boundedToolText(value: unknown, maximum: number, label: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximum ||
        /[\u0000-\u001f\u007f]/u.test(value)
    ) throw new TypeError(`${label} is invalid`)
    return value
}

function looksBinary(bytes: Buffer): boolean {
    const sample = bytes.subarray(0, Math.min(bytes.length, 8_192))
    if (sample.includes(0)) return true
    const decoded = sample.toString("utf8")
    const replacements = decoded.match(/\uFFFD/gu)?.length ?? 0
    return replacements > Math.max(2, decoded.length / 100)
}

function clipText(value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function clipUtf8(value: string, maximumBytes: number): string {
    if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value
    const marker = "\n... (read limit reached)"
    const contentBudget = maximumBytes - Buffer.byteLength(marker, "utf8")
    let low = 0
    let high = value.length
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentBudget) {
            low = middle
        } else {
            high = middle - 1
        }
    }
    const prefix = value.slice(0, low).replace(/[\uD800-\uDBFF]$/u, "")
    return `${prefix}${marker}`
}
