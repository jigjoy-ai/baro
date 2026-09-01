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
    CPU_PROBE_TIMEOUT_MS,
    createDefaultCpuActivityProbe,
    type CpuActivityProbe,
    type CpuActivitySample,
} from "./process-cpu-activity.js"
import {
    ManagedProcessTree,
    POSIX_PROCESS_GROUPS_SUPPORTED,
} from "./process-tree.js"

/**
 * How the timeout and idle watchdogs measure time.
 *
 * Injected because the alternative is proving their behaviour by racing a real
 * clock: a test then has to keep a child process talking faster than the
 * window, and reports the machine's scheduling as often as the code. Driving
 * the clock instead makes the same claim without a single sleep.
 */
export interface ExecFileCliTimers {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

const REAL_TIMERS: ExecFileCliTimers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type { CpuActivityProbe }

export interface ExecFileCliOptions {
    cwd?: string
    env?: NodeJS.ProcessEnv
    /** SIGTERM the child after this many ms; the promise rejects (killed=true). */
    timeout?: number
    /** SIGTERM the child after this many ms WITHOUT any stdout/stderr output
     *  AND without measured CPU progress across the tree. Every output chunk
     *  resets the clock; at expiry {@link cpuActivityProbe} gets the last word,
     *  so a silent-but-computing command is extended rather than killed. */
    idleTimeoutMs?: number
    /** Consulted only at idle expiry. Rejection, a hang, or an unobservable
     *  tree all count as active — the absolute `timeout` is the sole backstop. */
    cpuActivityProbe?: CpuActivityProbe
    /** Grace after SIGTERM before the complete CLI tree is SIGKILLed. */
    terminationGraceMs?: number
    /** Optional caller cancellation; abort follows the same tree cleanup path. */
    signal?: AbortSignal
    /** Reject once buffered stdout exceeds this many bytes. */
    maxBuffer?: number
    /** Optional exact UTF-8 stdin payload; stdin is otherwise closed/ignored. */
    input?: string
    /** Stream stdout to the caller instead of buffering it; the resolved
     *  stdout is then empty and maxBuffer no longer applies to stdout. Lets
     *  high-volume streams (per-token NDJSON) feed the idle watchdog without
     *  holding the whole transcript in memory. */
    onStdoutData?: (chunk: Buffer) => void
    /** Defaults to the real clock; see {@link ExecFileCliTimers}. */
    timers?: ExecFileCliTimers
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
        const cpuActivityProbe =
            options.cpuActivityProbe ?? createDefaultCpuActivityProbe(child.pid)
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
        const timers = options.timers ?? REAL_TIMERS
        let timer: unknown
        let idleTimer: unknown
        const probeTimers = new Set<unknown>()
        let terminationError: Error | undefined
        let treeRefreshed = false

        const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            if (timer) timers.clearTimeout(timer)
            if (idleTimer) timers.clearTimeout(idleTimer)
            for (const handle of probeTimers) timers.clearTimeout(handle)
            probeTimers.clear()
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
            timer = timers.setTimeout(() => {
                const err = new Error(
                    `${command} timed out after ${options.timeout}ms — exceeded the absolute command ceiling`,
                ) as Error & { killed: boolean }
                err.killed = true
                terminate(err)
            }, options.timeout)
        }
        const idleMs = options.idleTimeoutMs
        let cpuSample: CpuActivitySample | null = null
        // Bumped by every pet, so a probe that was still in flight when output
        // finally arrived cannot kill the process it was asking about.
        let idleGeneration = 0

        const presumedHung = (): void => {
            const err = new Error(
                `${command} produced no output for ${idleMs}ms — presumed hung`,
            ) as Error & { killed: boolean }
            err.killed = true
            terminate(err)
        }

        const onIdleExpiry = (generation: number): void => {
            if (settled || terminationError) return
            const rootPid = child.pid
            if (
                rootPid === undefined ||
                child.exitCode !== null ||
                child.signalCode !== null
            ) {
                presumedHung()
                return
            }
            type ProbeVerdict = { active: boolean; sample: CpuActivitySample | null }
            let raceTimer: unknown
            const bounded = new Promise<ProbeVerdict>((settle) => {
                raceTimer = timers.setTimeout(
                    () => settle({ active: true, sample: null }),
                    CPU_PROBE_TIMEOUT_MS,
                )
                probeTimers.add(raceTimer)
            })
            void Promise.race([
                cpuActivityProbe(rootPid, cpuSample).then(
                    (verdict): ProbeVerdict => verdict,
                    (): ProbeVerdict => ({ active: true, sample: null }),
                ),
                bounded,
            ]).then(({ active, sample }) => {
                if (probeTimers.delete(raceTimer)) timers.clearTimeout(raceTimer)
                if (settled || terminationError) return
                if (generation !== idleGeneration) return
                if (!active) {
                    presumedHung()
                    return
                }
                if (sample) cpuSample = sample
                petIdle()
            })
        }

        const petIdle = (): void => {
            if (!idleMs || idleMs <= 0 || settled || terminationError) return
            if (idleTimer) timers.clearTimeout(idleTimer)
            idleGeneration += 1
            const generation = idleGeneration
            idleTimer = timers.setTimeout(() => onIdleExpiry(generation), idleMs)
        }
        petIdle()
        options.signal?.addEventListener("abort", onAbort, { once: true })
        if (options.signal?.aborted) onAbort()

        child.stdout?.on("data", (d: Buffer) => {
            refreshProcessTree()
            petIdle()
            if (options.onStdoutData) {
                options.onStdoutData(d)
                return
            }
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
            petIdle()
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
        child.on("close", (code, signal) => {
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
                    // Reaching here means none of our own termination paths
                    // ran, so a signal came from outside. Naming it is the
                    // difference between "our git died" and an attributable
                    // fault; without it the report was `code null` and silence.
                    const err = new Error(
                        `${command} ${signal ? `was killed by ${signal}` : `exited with code ${code}`}` +
                            `\n${stderr.toString("utf8")}`,
                    ) as Error & {
                        code: number | null
                        signal: NodeJS.Signals | null
                        stdout: Buffer
                        stderr: Buffer
                    }
                    err.code = code
                    err.signal = signal
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
