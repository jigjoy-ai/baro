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

import { anyProcessAlive, signalProcessTree } from "./process-tree.js"

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

export function execFileCli(
    command: string,
    args: readonly string[],
    options: ExecFileCliOptions = {},
): Promise<{ stdout: string; stderr: string }> {
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
        } as SpawnOptions)

        let stdout = ""
        let stderr = ""
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let pollTimer: ReturnType<typeof setInterval> | undefined
        let terminationError: Error | undefined
        let signalledPids = new Set<number>()

        const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (killTimer) clearTimeout(killTimer)
            if (pollTimer) clearInterval(pollTimer)
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
            signalledPids = signalProcessTree(child, "SIGTERM", signalledPids)

            // A direct child can exit before a TERM-resistant grandchild. Keep
            // supervising the captured pids until all are gone or escalation
            // has been sent; resolving the promise earlier would recreate the
            // orphan race this helper exists to prevent.
            pollTimer = setInterval(() => {
                if (!anyProcessAlive(signalledPids)) finishTerminated()
            }, 25)
            killTimer = setTimeout(() => {
                signalledPids = signalProcessTree(
                    child,
                    "SIGKILL",
                    signalledPids,
                )
                finishTerminated()
            }, terminationGraceMs)
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
            stdout += d.toString()
            if (stdout.length > maxBuffer) {
                terminate(new Error(`${command} stdout exceeded maxBuffer`))
            }
        })
        child.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString()
        })
        child.stdin?.on("error", (err) => {
            if (!settled) terminate(err)
        })
        child.on("error", (err) => {
            if (terminationError) finishTerminated()
            else finish(() => reject(err))
        })
        child.on("close", (code) => {
            if (terminationError) {
                if (!anyProcessAlive(signalledPids)) finishTerminated()
                return
            }
            finish(() => {
                if (code === 0) {
                    resolve({ stdout, stderr })
                    return
                }
                const err = new Error(
                    `${command} exited with code ${code}\n${stderr}`,
                ) as Error & { code: number | null; stdout: string; stderr: string }
                err.code = code
                err.stdout = stdout
                err.stderr = stderr
                reject(err)
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
