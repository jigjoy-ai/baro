import { readFileSync } from "node:fs"

import { waitFor } from "./wait-for.js"

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

/**
 * A descendant that ignores SIGTERM lives for minutes unless it is killed, so
 * "gone shortly after cancellation settled" proves the escalation reached it.
 * Polling the pid itself keeps the proof independent of how loaded the machine
 * is; a wall-clock "it had not written a file yet" check is not.
 */
export async function assertProcessGone(pid: number, message: string): Promise<void> {
    await waitFor(() => !isAlive(pid), { message, timeoutMs: 5_000 })
}

/** The pid a fixture process wrote for itself, once the write has landed. */
export async function readPidFile(path: string): Promise<number> {
    const read = (): number => {
        try {
            return Number(readFileSync(path, "utf8").trim())
        } catch {
            return Number.NaN
        }
    }
    await waitFor(() => Number.isInteger(read()) && read() > 0, {
        message: `a pid in ${path}`,
    })
    return read()
}
