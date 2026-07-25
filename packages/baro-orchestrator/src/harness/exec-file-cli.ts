/**
 * Windows-safe execFile for npm-installed CLIs (claude/codex/… ship as `.cmd`
 * shims on Windows). Node's execFile/spawn won't resolve PATHEXT without a
 * shell, so execFile("claude") throws `spawn claude ENOENT` even when
 * claude.cmd is on PATH. cross-spawn resolves the real target cross-platform
 * and escapes args correctly, so we keep shell:false. Large prompt payloads
 * may be delivered over stdin to avoid Windows' command-line length cap.
 * Buffers stdout/stderr to preserve execFile's promise
 * shape (`{ stdout }`), with the same timeout + maxBuffer semantics.
 */

import type { SpawnOptions } from "child_process"
import spawn from "cross-spawn"

import {
    ManagedProcessTree,
    POSIX_PROCESS_GROUPS_SUPPORTED,
} from "./process-tree.js"

export interface ExecFileCliOptions {
    cwd?: string
    env?: NodeJS.ProcessEnv
    /** SIGTERM the child after this many ms; the promise rejects (killed=true). */
    timeout?: number
    /** Grace after SIGTERM before the complete CLI tree is SIGKILLed. */
    terminationGraceMs?: number
    /** Optional caller cancellation; abort follows the same tree cleanup path. */
    signal?: AbortSignal
    /** Reject once buffered stdout exceeds this many bytes. */
    maxBuffer?: number
    /** Optional exact UTF-8 stdin payload; stdin is otherwise closed/ignored. */
    input?: string
}

export interface ExecFileCliBufferResult {
    stdout: Buffer
    stderr: Buffer
}

export async function execFileCli(
    command: string,
    args: readonly string[],
    options: ExecFileCliOptions = {},
): Promise<{ stdout: string; stderr: string }> {
    try {
        const result = await execFileCliRaw(command, args, options)
        return {
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
        }
    } catch (error) {
        if (error instanceof Error) {
            const failure = error as Error & {
                stdout?: unknown
                stderr?: unknown
            }
            if (Buffer.isBuffer(failure.stdout)) {
                failure.stdout = failure.stdout.toString("utf8")
            }
            if (Buffer.isBuffer(failure.stderr)) {
                failure.stderr = failure.stderr.toString("utf8")
            }
        }
        throw error
    }
}

/** Exact byte-preserving variant used when repository evidence is hashed/rendered. */
export function execFileCliBuffer(
    command: string,
    args: readonly string[],
    options: ExecFileCliOptions = {},
): Promise<ExecFileCliBufferResult> {
    return execFileCliRaw(command, args, options)
}

function execFileCliRaw(
    command: string,
    args: readonly string[],
    options: ExecFileCliOptions = {},
): Promise<ExecFileCliBufferResult> {
    const maxBuffer = options.maxBuffer ?? 1024 * 1024
    const terminationGraceMs = options.terminationGraceMs ?? 5_000
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 1) {
        return Promise.reject(
            new RangeError("execFileCli: terminationGraceMs must be positive"),
        )
    }
    if (options.signal?.aborted) {
        return Promise.reject(abortError(command))
    }
    return new Promise((resolve, reject) => {
        const child = spawn(command, args as string[], {
            cwd: options.cwd,
            env: options.env,
            stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            detached: POSIX_PROCESS_GROUPS_SUPPORTED,
        } as SpawnOptions)
        const processTree = new ManagedProcessTree(child, {
            terminationGraceMs,
            pollIntervalMs: 25,
            ownsProcessGroup: POSIX_PROCESS_GROUPS_SUPPORTED,
        })

        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let stdoutCapped = false
        let stderrCapped = false
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let terminationError: Error | undefined
        let treeRefreshed = false

        const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            options.signal?.removeEventListener("abort", onAbort)
            fn()
        }

        const finishTerminated = (): void => {
            const error = terminationError
            if (error) finish(() => reject(error))
        }

        const terminate = (error: Error): void => {
            if (terminationError) return
            terminationError = error
            processTree.terminate("SIGTERM")
            void processTree.done.then(() => {
                child.stdin?.destroy()
                child.stdout?.destroy()
                child.stderr?.destroy()
                finishTerminated()
            })
        }

        const refreshProcessTree = (): void => {
            if (treeRefreshed) return
            treeRefreshed = true
            processTree.refresh()
        }

        const onAbort = (): void => terminate(abortError(command))

        if (options.timeout && options.timeout > 0) {
            timer = setTimeout(() => {
                const err = new Error(
                    `${command} timed out after ${options.timeout}ms`,
                ) as Error & { killed: boolean }
                err.killed = true
                terminate(err)
            }, options.timeout)
        }
        options.signal?.addEventListener("abort", onAbort, { once: true })
        if (options.signal?.aborted) onAbort()

        child.stdout?.on("data", (d: Buffer) => {
            refreshProcessTree()
            if (stdoutCapped) return
            const remaining = Math.max(0, maxBuffer - stdoutBytes)
            if (remaining > 0) {
                stdoutChunks.push(Buffer.from(d.subarray(0, remaining)))
            }
            stdoutBytes += Math.min(d.length, remaining)
            if (d.length > remaining) {
                stdoutCapped = true
                terminate(new Error(`${command} stdout exceeded maxBuffer`))
            }
        })
        child.stderr?.on("data", (d: Buffer) => {
            refreshProcessTree()
            if (stderrCapped) return
            const remaining = Math.max(0, maxBuffer - stderrBytes)
            if (remaining > 0) {
                stderrChunks.push(Buffer.from(d.subarray(0, remaining)))
            }
            stderrBytes += Math.min(d.length, remaining)
            if (d.length > remaining) {
                stderrCapped = true
                terminate(new Error(`${command} stderr exceeded maxBuffer`))
            }
        })
        child.stdin?.on("error", (err) => {
            if (!settled) terminate(err)
        })
        child.on("error", (err) => {
            if (!terminationError) terminationError = err
            if (child.pid === undefined) processTree.markRootClosed()
            else processTree.terminate("SIGTERM")
            void processTree.done.then(finishTerminated)
        })
        child.on("exit", () => {
            processTree.markRootClosed()
        })
        child.on("close", (code) => {
            if (terminationError) {
                void processTree.done.then(finishTerminated)
                return
            }
            void processTree.done.then(() => {
                finish(() => {
                    const stdout = Buffer.concat(stdoutChunks, stdoutBytes)
                    const stderr = Buffer.concat(stderrChunks, stderrBytes)
                    if (code === 0) {
                        resolve({ stdout, stderr })
                        return
                    }
                    const err = new Error(
                        `${command} exited with code ${code}\n${stderr.toString("utf8")}`,
                    ) as Error & { code: number | null; stdout: Buffer; stderr: Buffer }
                    err.code = code
                    err.stdout = stdout
                    err.stderr = stderr
                    reject(err)
                })
            })
        })
        if (options.input !== undefined) child.stdin?.end(options.input)
    })
}

function abortError(command: string): Error {
    const error = new Error(`${command} aborted`)
    error.name = "AbortError"
    return error
}
