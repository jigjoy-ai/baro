// Generous by default: these bounds only catch hangs, and a loaded machine
// running the full suite can stretch a spawn or `ps` scan to seconds.
export const GENEROUS_WAIT_MS = 30_000

export async function waitFor(
    condition: () => boolean,
    {
        timeoutMs = GENEROUS_WAIT_MS,
        intervalMs = 10,
        message = "condition",
    }: { timeoutMs?: number; intervalMs?: number; message?: string | (() => string) } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
        if (Date.now() >= deadline) {
            const text = typeof message === "function" ? message() : message
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${text}`)
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
}

export async function withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string | (() => string),
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                typeof message === "function" ? message() : message,
                            ),
                        ),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

/** Polls until `pid` is gone; throws if it outlives the bound. */
export async function waitForPidExit(
    pid: number,
    timeoutMs = GENEROUS_WAIT_MS,
): Promise<void> {
    await waitFor(() => !isPidAlive(pid), {
        timeoutMs,
        message: `pid ${pid} to exit`,
    })
}
