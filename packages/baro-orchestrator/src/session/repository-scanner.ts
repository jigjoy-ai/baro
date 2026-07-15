import { createHash, type Hash } from "node:crypto"
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
    basename,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path"

import type { ConversationRequestIntent } from "./conversation-intake.js"
import {
    REPOSITORY_BRIEF_SCHEMA_VERSION,
    validateRepositoryBriefV1,
    validateRepositoryEvidencePath,
    type RepositoryBriefV1,
    type RepositoryFactConfidence,
    type RepositoryFactV1,
} from "./repository-brief.js"

const DEFAULT_MAX_FILES = 5_000
const DEFAULT_MAX_FILE_BYTES = 256 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 25_000
const DEFAULT_MAX_RELEVANT_PATHS = 48
const DEFAULT_MAX_FACTS = 32
const MAX_GOAL_TERMS = 24

const IGNORED_DIRECTORIES = new Set([
    ".baro",
    ".git",
    ".hg",
    ".svn",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
])

const SENSITIVE_DIRECTORIES = new Set([
    ".aws",
    ".azure",
    ".config/gcloud",
    ".docker",
    ".gnupg",
    ".kube",
    ".ssh",
    ".terraform",
])

const SENSITIVE_BASENAMES = new Set([
    ".dockercfg",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "_netrc",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
])

const SENSITIVE_EXTENSIONS = new Set([
    ".der",
    ".jks",
    ".key",
    ".keystore",
    ".p12",
    ".pem",
    ".pfx",
])

const TEXT_EXTENSIONS = new Set([
    ".c", ".cc", ".cfg", ".clj", ".cljs", ".conf", ".cpp", ".cs",
    ".css", ".csv", ".dart", ".ex", ".exs", ".go", ".graphql", ".h",
    ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt",
    ".kts", ".less", ".lua", ".md", ".mdx", ".mjs", ".mts", ".php",
    ".prisma", ".properties", ".proto", ".ps1", ".py", ".rb", ".rs",
    ".sass", ".scala", ".scss", ".sh", ".sql", ".svelte", ".swift",
    ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
    ".zig", ".zsh",
])

const TEXT_BASENAMES = new Set([
    "agents.md",
    "cargo.lock",
    "cargo.toml",
    "changelog",
    "changelog.md",
    "claude.md",
    "codeowners",
    "dockerfile",
    "gemfile",
    "go.mod",
    "go.sum",
    "license",
    "makefile",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "readme",
    "readme.md",
    "requirements.txt",
    "tsconfig.json",
    "yarn.lock",
])

const STOP_WORDS = new Set([
    "about", "after", "again", "also", "build", "change", "code", "could",
    "from", "have", "into", "make", "need", "please", "repo", "repository",
    "should", "that", "this", "with", "would", "onda", "kako", "koji", "koja",
    "koje", "moze", "mozes", "treba", "uradi", "sada", "onda", "bismo", "bude",
])

export interface RepositoryContextScanRequest {
    query: string
    intent: Exclude<ConversationRequestIntent, "chat">
    /** Trusted event-bus correlation; repository-derived data cannot choose it. */
    correlation?: Readonly<{
        sessionId: string
        requestId: string
        contextRequestId: string
    }>
}

export interface RepositoryContextScanner {
    scan(
        request: RepositoryContextScanRequest,
        signal: AbortSignal,
    ): Promise<RepositoryBriefV1>
}

export interface DeterministicRepositoryScannerOptions {
    maxEntries?: number
    maxFiles?: number
    maxFileBytes?: number
    maxTotalBytes?: number
    maxRelevantPaths?: number
    maxFacts?: number
}

interface IndexedFile {
    path: string
    score: number
    matchedTerms: readonly string[]
    firstMatchLine?: number
    pathMatch: boolean
    contentMatch: boolean
}

interface ScanState {
    hash: Hash
    terms: readonly string[]
    files: IndexedFile[]
    indexedFiles: number
    indexedBytes: number
    unreadableFiles: number
    binaryFiles: number
    excludedSymlinks: number
    truncated: boolean
    visits: number
    stopTraversal: boolean
}

interface BoundedDirectoryEntries {
    entries: Dirent[]
    limited: boolean
}

/**
 * Deterministic Baro-owned repository retrieval. It has no model, shell,
 * subprocess, write, or tool-execution capability. Paths come only from
 * directory entries beneath a canonical root; observed symlinks are rejected.
 * A concurrently hostile checkout still requires an immutable filesystem
 * boundary to eliminate path-check races.
 */
export class DeterministicRepositoryScanner implements RepositoryContextScanner {
    private readonly root: string
    private readonly maxFiles: number
    private readonly maxEntries: number
    private readonly maxFileBytes: number
    private readonly maxTotalBytes: number
    private readonly maxRelevantPaths: number
    private readonly maxFacts: number

    constructor(
        root: string,
        options: DeterministicRepositoryScannerOptions = {},
    ) {
        const resolved = realpathSync(resolve(root))
        if (!statSync(resolved).isDirectory()) {
            throw new TypeError("repository scanner root must be a directory")
        }
        this.root = resolved
        this.maxEntries = boundedPositiveInteger(
            options.maxEntries ?? DEFAULT_MAX_ENTRIES,
            "maxEntries",
            DEFAULT_MAX_ENTRIES,
        )
        this.maxFiles = boundedPositiveInteger(
            options.maxFiles ?? DEFAULT_MAX_FILES,
            "maxFiles",
            DEFAULT_MAX_FILES,
        )
        this.maxFileBytes = boundedPositiveInteger(
            options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
            "maxFileBytes",
            DEFAULT_MAX_FILE_BYTES,
        )
        this.maxTotalBytes = boundedPositiveInteger(
            options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
            "maxTotalBytes",
            DEFAULT_MAX_TOTAL_BYTES,
        )
        this.maxRelevantPaths = boundedPositiveInteger(
            options.maxRelevantPaths ?? DEFAULT_MAX_RELEVANT_PATHS,
            "maxRelevantPaths",
            DEFAULT_MAX_RELEVANT_PATHS,
        )
        this.maxFacts = boundedPositiveInteger(
            options.maxFacts ?? DEFAULT_MAX_FACTS,
            "maxFacts",
            DEFAULT_MAX_FACTS,
        )
    }

    async scan(
        request: RepositoryContextScanRequest,
        signal: AbortSignal,
    ): Promise<RepositoryBriefV1> {
        if (request.intent !== "goal" && request.intent !== "clarification") {
            throw new TypeError("repository scan intent must require repository context")
        }
        if (typeof request.query !== "string" || request.query.trim().length === 0) {
            throw new TypeError("repository scan query must be non-empty")
        }
        throwIfAborted(signal)
        const state: ScanState = {
            hash: createHash("sha256").update("baro-repository-snapshot-v1\0"),
            terms: tokenizeGoal(request.query),
            files: [],
            indexedFiles: 0,
            indexedBytes: 0,
            unreadableFiles: 0,
            binaryFiles: 0,
            excludedSymlinks: 0,
            truncated: false,
            visits: 0,
            stopTraversal: false,
        }
        await this.walk(this.root, "", state, signal)
        throwIfAborted(signal)

        const ranked = [...state.files].sort(compareIndexedFiles)
        const matched = ranked.filter((file) => file.score > 0)
        const relevant = matched
            .slice(0, this.maxRelevantPaths)
        const relevantPaths = relevant.map((file) => file.path)
        const facts = relevant.slice(0, this.maxFacts).map(repositoryFact)
        const outputTruncated =
            matched.length > this.maxRelevantPaths ||
            relevant.length > this.maxFacts
        const unknowns: string[] = [
            "Repository behavior and build/test results were not executed or verified.",
        ]
        if (relevant.length === 0) {
            unknowns.push("No indexed text file matched the bounded goal terms.")
        }
        if (state.truncated) {
            unknowns.push(
                "The repository scan hit a configured file, byte, or directory-entry bound.",
            )
        }
        if (outputTruncated) {
            unknowns.push("Ranked repository evidence exceeded the bounded output lists.")
        }
        if (state.excludedSymlinks > 0) {
            unknowns.push("Symbolic links were excluded and their targets were not inspected.")
        }
        if (state.unreadableFiles > 0) {
            unknowns.push("Some eligible files could not be read during the snapshot.")
        }
        if (state.binaryFiles > 0) {
            unknowns.push("Binary-looking files were not used as conversation evidence.")
        }

        const brief = {
            schemaVersion: REPOSITORY_BRIEF_SCHEMA_VERSION,
            snapshotId: `sha256:${state.hash.digest("hex")}`,
            summary:
                `Deterministic read-only scan indexed ${state.indexedFiles} text file(s) ` +
                `and ${state.indexedBytes} byte(s); ${relevant.length} bounded path(s) ` +
                "matched the goal or repository entry-point heuristics.",
            facts,
            relevantPaths,
            unknowns,
            truncated: state.truncated || outputTruncated,
        }
        return validateRepositoryBriefV1(brief)
    }

    private async walk(
        absoluteDirectory: string,
        relativeDirectory: string,
        state: ScanState,
        signal: AbortSignal,
    ): Promise<void> {
        throwIfAborted(signal)
        if (state.stopTraversal) return
        const remainingEntries = this.maxEntries - state.visits
        if (remainingEntries <= 0) {
            state.truncated = true
            state.stopTraversal = true
            return
        }
        const collected = await readBoundedDirectoryEntries(
            absoluteDirectory,
            remainingEntries,
            signal,
        )
        if (collected === null) {
            state.unreadableFiles += 1
            return
        }
        if (collected.limited) state.truncated = true

        for (const entry of collected.entries) {
            throwIfAborted(signal)
            if (state.visits >= this.maxEntries) {
                state.truncated = true
                state.stopTraversal = true
                return
            }
            state.visits += 1
            if (state.visits % 64 === 0) await yieldToEventLoop()

            const relativePath = relativeDirectory
                ? `${relativeDirectory}/${entry.name}`
                : entry.name
            let safePath: string
            try {
                safePath = validateRepositoryEvidencePath(relativePath)
            } catch {
                state.truncated = true
                continue
            }
            if (repositoryPathIsSensitive(safePath)) continue

            const absolutePath = join(absoluteDirectory, entry.name)
            let metadata
            try {
                metadata = lstatSync(absolutePath)
            } catch {
                state.unreadableFiles += 1
                continue
            }
            if (metadata.isSymbolicLink()) {
                state.excludedSymlinks += 1
                continue
            }
            if (metadata.isDirectory()) {
                if (repositoryDirectoryIsIgnored(entry.name)) continue
                let canonical: string
                try {
                    canonical = realpathSync(absolutePath)
                } catch {
                    state.unreadableFiles += 1
                    continue
                }
                if (!this.contains(canonical)) {
                    state.excludedSymlinks += 1
                    continue
                }
                await this.walk(canonical, safePath, state, signal)
                if (state.stopTraversal) return
                continue
            }
            if (!metadata.isFile() || !repositoryTextPathIsEligible(safePath)) continue
            if (state.indexedFiles >= this.maxFiles) {
                state.truncated = true
                continue
            }
            if (metadata.size > this.maxFileBytes) {
                state.truncated = true
                continue
            }
            if (state.indexedBytes + metadata.size > this.maxTotalBytes) {
                state.truncated = true
                continue
            }

            const bytes = this.readContainedRegularFile(absolutePath, metadata.size)
            if (bytes === null) {
                state.unreadableFiles += 1
                continue
            }
            if (looksBinary(bytes)) {
                state.binaryFiles += 1
                continue
            }
            const content = bytes.toString("utf8")
            updateHashLength(state.hash, Buffer.byteLength(safePath, "utf8"))
            state.hash.update(safePath, "utf8")
            updateHashLength(state.hash, bytes.length)
            state.hash.update(bytes)
            state.indexedFiles += 1
            state.indexedBytes += bytes.length
            state.files.push(indexFile(safePath, content, state.terms))
        }
        if (collected.limited) state.stopTraversal = true
    }

    private readContainedRegularFile(
        absolutePath: string,
        expectedSize: number,
    ): Buffer | null {
        let canonical: string
        try {
            canonical = realpathSync(absolutePath)
        } catch {
            return null
        }
        if (!this.contains(canonical)) return null

        let descriptor: number | null = null
        try {
            descriptor = openSync(
                absolutePath,
                constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            )
            const metadata = fstatSync(descriptor)
            if (
                !metadata.isFile() ||
                metadata.size !== expectedSize ||
                metadata.size > this.maxFileBytes ||
                metadata.size > this.maxTotalBytes
            ) {
                return null
            }
            const bytes = Buffer.alloc(metadata.size)
            let offset = 0
            while (offset < bytes.length) {
                const count = readSync(
                    descriptor,
                    bytes,
                    offset,
                    bytes.length - offset,
                    null,
                )
                if (count === 0) return null
                offset += count
            }
            const overflowProbe = Buffer.alloc(1)
            if (readSync(descriptor, overflowProbe, 0, 1, null) !== 0) return null
            if (fstatSync(descriptor).size !== metadata.size) return null
            return bytes
        } catch {
            return null
        } finally {
            if (descriptor !== null) closeSync(descriptor)
        }
    }

    private contains(candidate: string): boolean {
        const fromRoot = relative(this.root, candidate)
        return fromRoot === "" || (
            fromRoot !== ".." &&
            !fromRoot.startsWith(`..${sep}`) &&
            !isAbsolute(fromRoot)
        )
    }
}

/**
 * Collects only the remaining global traversal budget plus one overflow probe.
 * The retained prefix is sorted before traversal for stable processing on a
 * given filesystem; a truncated directory is explicitly reported as such.
 */
async function readBoundedDirectoryEntries(
    absoluteDirectory: string,
    maximumEntries: number,
    signal: AbortSignal,
): Promise<BoundedDirectoryEntries | null> {
    throwIfAborted(signal)
    let directory
    try {
        directory = await opendir(absoluteDirectory)
    } catch {
        throwIfAborted(signal)
        return null
    }

    const entries: Dirent[] = []
    let limited = false
    try {
        while (entries.length < maximumEntries) {
            throwIfAborted(signal)
            const entry = await directory.read()
            throwIfAborted(signal)
            if (entry === null) break
            entries.push(entry)
            if (entries.length % 64 === 0) await yieldToEventLoop()
        }
        if (entries.length === maximumEntries) {
            throwIfAborted(signal)
            limited = await directory.read() !== null
            throwIfAborted(signal)
        }
    } catch {
        throwIfAborted(signal)
        return null
    } finally {
        await directory.close().catch(() => undefined)
    }

    entries.sort((left, right) => compareText(left.name, right.name))
    return { entries, limited }
}

function indexFile(
    path: string,
    content: string,
    terms: readonly string[],
): IndexedFile {
    const lowerPath = path.toLocaleLowerCase("en")
    const lowerContent = content.toLocaleLowerCase("en")
    const pathTerms = terms.filter((term) => lowerPath.includes(term))
    const contentTerms: string[] = []
    let firstMatchIndex: number | undefined
    for (const term of terms) {
        const index = lowerContent.indexOf(term)
        if (index < 0) continue
        contentTerms.push(term)
        if (firstMatchIndex === undefined || index < firstMatchIndex) firstMatchIndex = index
    }
    const matchedTerms = [...new Set([...pathTerms, ...contentTerms])].slice(0, 8)
    const important = entryPointScore(path)
    return {
        path,
        score: important + pathTerms.length * 30 + contentTerms.length * 8,
        matchedTerms,
        ...(firstMatchIndex !== undefined
            ? { firstMatchLine: lineNumberAt(content, firstMatchIndex) }
            : {}),
        pathMatch: pathTerms.length > 0,
        contentMatch: contentTerms.length > 0,
    }
}

function repositoryFact(file: IndexedFile): RepositoryFactV1 {
    const matched = file.matchedTerms.length > 0
        ? ` Matched bounded goal term(s): ${file.matchedTerms.join(", ")}.`
        : ""
    const source = file.pathMatch && file.contentMatch
        ? "path and indexed text"
        : file.pathMatch
          ? "path"
          : file.contentMatch
            ? "indexed text"
            : "repository entry-point heuristic"
    const confidence: RepositoryFactConfidence = file.pathMatch && file.contentMatch
        ? "high"
        : file.pathMatch || file.contentMatch
          ? "medium"
          : "low"
    return {
        statement: `This file was selected by ${source}.${matched}`,
        evidencePath: file.path,
        ...(file.firstMatchLine !== undefined ? { line: file.firstMatchLine } : {}),
        confidence,
    }
}

function compareIndexedFiles(left: IndexedFile, right: IndexedFile): number {
    return right.score - left.score || compareText(left.path, right.path)
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function tokenizeGoal(query: string): string[] {
    const terms = query
        .normalize("NFKC")
        .toLocaleLowerCase("en")
        .match(/[\p{L}\p{N}_-]{3,}/gu) ?? []
    const unique: string[] = []
    const seen = new Set<string>()
    for (const term of terms) {
        if (term.length > 48 || STOP_WORDS.has(term) || seen.has(term)) continue
        seen.add(term)
        unique.push(term)
        if (unique.length === MAX_GOAL_TERMS) break
    }
    return unique
}

/** Shared allow-list for read-only repository research surfaces. */
export function repositoryTextPathIsEligible(path: string): boolean {
    const name = basename(path).toLowerCase()
    return TEXT_BASENAMES.has(name) || TEXT_EXTENSIONS.has(extname(name))
}

/** Shared deny-list for credentials, private keys, and local cloud/home state. */
export function repositoryPathIsSensitive(path: string): boolean {
    const lower = path.toLowerCase()
    const segments = lower.split("/")
    if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
        return true
    }
    if (segments.some((segment) => SENSITIVE_BASENAMES.has(segment))) return true
    if (SENSITIVE_EXTENSIONS.has(extname(segments.at(-1) ?? ""))) return true
    if (
        lower === ".config/gcloud" ||
        lower.startsWith(".config/gcloud/") ||
        lower.endsWith("/.config/gcloud") ||
        lower.includes("/.config/gcloud/")
    ) return true
    for (let index = 0; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index + 1).join("/")
        if (SENSITIVE_DIRECTORIES.has(prefix) || SENSITIVE_DIRECTORIES.has(segments[index]!)) {
            return true
        }
    }
    return false
}

/** Directory policy shared by deterministic and autonomous retrieval. */
export function repositoryDirectoryIsIgnored(name: string): boolean {
    return IGNORED_DIRECTORIES.has(name.toLowerCase())
}

function entryPointScore(path: string): number {
    const name = basename(path).toLowerCase()
    if (name === "agents.md" || name === "claude.md") return 12
    if (name.startsWith("readme")) return 10
    if (TEXT_BASENAMES.has(name)) return 6
    return 0
}

function lineNumberAt(content: string, index: number): number {
    let line = 1
    for (let offset = 0; offset < index; offset += 1) {
        if (content.charCodeAt(offset) === 10) line += 1
    }
    return line
}

function looksBinary(bytes: Buffer): boolean {
    const sample = bytes.subarray(0, Math.min(bytes.length, 8_192))
    if (sample.includes(0)) return true
    const decoded = sample.toString("utf8")
    const replacements = decoded.match(/\uFFFD/gu)?.length ?? 0
    return replacements > Math.max(2, decoded.length / 100)
}

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(`${label} must be a positive integer no greater than ${maximum}`)
    }
    return value
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("repository scan was aborted")
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolveYield) => setImmediate(resolveYield))
}

function updateHashLength(hash: Hash, length: number): void {
    const encoded = Buffer.allocUnsafe(8)
    encoded.writeBigUInt64BE(BigInt(length))
    hash.update(encoded)
}
