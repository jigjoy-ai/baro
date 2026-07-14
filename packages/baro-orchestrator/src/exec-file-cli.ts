/**
 * Windows-safe execFile for npm-installed CLIs (claude/codex/… ship as `.cmd`
 * shims on Windows). Node's execFile/spawn won't resolve PATHEXT without a
 * shell, so execFile("claude") throws `spawn claude ENOENT` even when
 * claude.cmd is on PATH. cross-spawn resolves the real target cross-platform
 * and escapes args correctly (prompts pass as argv, never a shell string), so
 * we keep shell:false. Buffers stdout/stderr to preserve execFile's promise
 * shape (`{ stdout }`), with the same timeout + maxBuffer semantics.
 */

import type { SpawnOptions } from "child_process"
import spawn from "cross-spawn"

export interface ExecFileCliOptions {
    cwd?: string
    env?: NodeJS.ProcessEnv
    /** SIGTERM the child after this many ms; the promise rejects (killed=true). */
    timeout?: number
    /** Reject once buffered stdout exceeds this many bytes. */
    maxBuffer?: number
}

export function execFileCli(
    command: string,
    args: readonly string[],
    options: ExecFileCliOptions = {},
): Promise<{ stdout: string; stderr: string }> {
    const maxBuffer = options.maxBuffer ?? 1024 * 1024
    return new Promise((resolve, reject) => {
        const child = spawn(command, args as string[], {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
        } as SpawnOptions)

        let stdout = ""
        let stderr = ""
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const finish = (fn: () => void): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            fn()
        }

        if (options.timeout && options.timeout > 0) {
            timer = setTimeout(() => {
                child.kill("SIGTERM")
                finish(() => {
                    const err = new Error(
                        `${command} timed out after ${options.timeout}ms`,
                    ) as Error & { killed: boolean }
                    err.killed = true
                    reject(err)
                })
            }, options.timeout)
        }

        child.stdout?.on("data", (d: Buffer) => {
            stdout += d.toString()
            if (stdout.length > maxBuffer) {
                child.kill("SIGTERM")
                finish(() =>
                    reject(new Error(`${command} stdout exceeded maxBuffer`)),
                )
            }
        })
        child.stderr?.on("data", (d: Buffer) => {
            stderr += d.toString()
        })
        child.on("error", (err) => finish(() => reject(err)))
        child.on("close", (code) => {
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
    })
}
