import { basename } from "node:path"

import { execFileCli, execFileCliBuffer } from "./exec-file-cli.js"

/**
 * Repository commands should normally finish in seconds, but large worktrees
 * and slow remote pushes need substantially more room than provider-control
 * subprocesses. This is a liveness ceiling, not a performance target.
 */
export const DEFAULT_REPOSITORY_COMMAND_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_REPOSITORY_COMMAND_MAX_BUFFER = 16 * 1024 * 1024

const TIMEOUT_ENV = "BARO_REPOSITORY_COMMAND_TIMEOUT_SECS"
const MAX_TIMER_MS = 2_147_483_647

export interface RepositoryCommandOptions {
    cwd: string
    /** Per-command override used by focused tests and embedded callers. */
    timeoutMs?: number
    /** Independent cap applied to each of stdout and stderr. */
    maxBuffer?: number
    /** Grace after SIGTERM before the complete process tree is SIGKILLed. */
    terminationGraceMs?: number
    signal?: AbortSignal
    env?: NodeJS.ProcessEnv
}

export type RepositoryCommand = (
    command: string,
    args: readonly string[],
    options: RepositoryCommandOptions,
) => Promise<{ stdout: string; stderr: string }>

export type RepositoryBufferCommand = (
    command: string,
    args: readonly string[],
    options: RepositoryCommandOptions,
) => Promise<{ stdout: Buffer; stderr: Buffer }>

export class RepositoryCommandError extends Error {
    readonly command: string
    readonly operation: string
    readonly cwd: string
    readonly timeoutMs: number
    readonly timedOut: boolean
    readonly killed: boolean
    readonly code: number | string | null | undefined
    readonly stdout: string
    readonly stderr: string
    /** Exact captured bytes when the byte-preserving command path was used. */
    readonly stdoutBuffer: Buffer | null
    readonly stderrBuffer: Buffer | null

    constructor(
        command: string,
        args: readonly string[],
        options: Required<
            Pick<RepositoryCommandOptions, "cwd" | "timeoutMs" | "maxBuffer">
        >,
        cause: unknown,
    ) {
        const source = asCommandFailure(cause)
        const timedOut = source.killed === true && /timed out/iu.test(source.message)
        const operation = repositoryOperation(command, args)
        const detail = timedOut
            ? `timed out after ${options.timeoutMs}ms`
            : source.message
        super(
            `repository command ${operation} ${detail} ` +
                `(cwd: ${options.cwd})`,
            { cause },
        )
        this.name = "RepositoryCommandError"
        this.command = command
        this.operation = operation
        this.cwd = options.cwd
        this.timeoutMs = options.timeoutMs
        this.timedOut = timedOut
        this.killed = source.killed === true
        this.code = source.code
        this.stdout = source.stdout
        this.stderr = source.stderr
        this.stdoutBuffer = rawFailureBuffer(cause, "stdout")
        this.stderrBuffer = rawFailureBuffer(cause, "stderr")
    }
}

function rawFailureBuffer(
    error: unknown,
    field: "stdout" | "stderr",
): Buffer | null {
    if (!(error instanceof Error)) return null
    const value = (error as Error & Record<typeof field, unknown>)[field]
    return Buffer.isBuffer(value) ? Buffer.from(value) : null
}

/**
 * Run one repository CLI command with bounded output and complete process-tree
 * cleanup. `execFileCli` settles only after ManagedProcessTree has drained, so
 * a caller may safely release GitGate in its `finally` after this promise.
 */
export const runRepositoryCommand: RepositoryCommand = async (
    command,
    args,
    options,
) => {
    const timeoutMs = normalizePositiveInteger(
        options.timeoutMs ?? repositoryCommandTimeoutMs(),
        "repository command timeoutMs",
    )
    const maxBuffer = normalizePositiveInteger(
        options.maxBuffer ?? DEFAULT_REPOSITORY_COMMAND_MAX_BUFFER,
        "repository command maxBuffer",
    )
    try {
        return await execFileCli(command, args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            timeout: timeoutMs,
            maxBuffer,
            terminationGraceMs: options.terminationGraceMs,
        })
    } catch (error) {
        throw new RepositoryCommandError(
            command,
            args,
            { cwd: options.cwd, timeoutMs, maxBuffer },
            error,
        )
    }
}

/** Byte-preserving repository command for exact diff/status evidence. */
export const runRepositoryCommandBuffer: RepositoryBufferCommand = async (
    command,
    args,
    options,
) => {
    const timeoutMs = normalizePositiveInteger(
        options.timeoutMs ?? repositoryCommandTimeoutMs(),
        "repository command timeoutMs",
    )
    const maxBuffer = normalizePositiveInteger(
        options.maxBuffer ?? DEFAULT_REPOSITORY_COMMAND_MAX_BUFFER,
        "repository command maxBuffer",
    )
    try {
        return await execFileCliBuffer(command, args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            timeout: timeoutMs,
            maxBuffer,
            terminationGraceMs: options.terminationGraceMs,
        })
    } catch (error) {
        throw new RepositoryCommandError(
            command,
            args,
            { cwd: options.cwd, timeoutMs, maxBuffer },
            error,
        )
    }
}

/** Resolve the production deadline at call time so tests need no module reset. */
export function repositoryCommandTimeoutMs(
    env: NodeJS.ProcessEnv = process.env,
): number {
    const raw = env[TIMEOUT_ENV]?.trim()
    if (!raw) return DEFAULT_REPOSITORY_COMMAND_TIMEOUT_MS
    const seconds = Number(raw)
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return DEFAULT_REPOSITORY_COMMAND_TIMEOUT_MS
    }
    return Math.max(1, Math.min(Math.ceil(seconds * 1_000), MAX_TIMER_MS))
}

export function isRepositoryCommandTimeout(
    error: unknown,
): error is RepositoryCommandError {
    return error instanceof RepositoryCommandError && error.timedOut
}

function repositoryOperation(command: string, args: readonly string[]): string {
    const executable = basename(command) || command
    const subcommand = args[0]?.trim()
    // The subcommand is enough to identify the failed operation without
    // copying remote URLs, credentials, or user-controlled paths into logs.
    return JSON.stringify(subcommand ? `${executable} ${subcommand}` : executable)
}

function normalizePositiveInteger(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${label} must be finite and positive`)
    }
    return Math.min(Math.ceil(value), MAX_TIMER_MS)
}

function asCommandFailure(error: unknown): {
    message: string
    killed?: boolean
    code?: number | string | null
    stdout: string
    stderr: string
} {
    if (!(error instanceof Error)) {
        return {
            message: String(error),
            stdout: "",
            stderr: "",
        }
    }
    const failure = error as Error & {
        killed?: boolean
        code?: number | string | null
        stdout?: unknown
        stderr?: unknown
    }
    return {
        message: failure.message,
        killed: failure.killed,
        code: failure.code,
        stdout: typeof failure.stdout === "string"
            ? failure.stdout
            : Buffer.isBuffer(failure.stdout)
            ? failure.stdout.toString("utf8")
            : "",
        stderr: typeof failure.stderr === "string"
            ? failure.stderr
            : Buffer.isBuffer(failure.stderr)
            ? failure.stderr.toString("utf8")
            : "",
    }
}
