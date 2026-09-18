import { watch, type FSWatcher } from "node:fs"

import { createAwakeDeadline, type AwakeClock } from "../runtime/awake-clock.js"
import {
    activityIdleTimeoutMs,
    startActivityWatchdog,
    StoryAttemptTimeoutError,
} from "./liveness.js"

/** Git's own bookkeeping (index refreshes, lock files) is not the agent
 *  working, so it never counts as activity. */
export function watchWorktreeActivity(
    root: string,
    onActivity: () => void,
): () => void {
    let watcher: FSWatcher
    try {
        watcher = watch(root, { recursive: true }, (_event, file) => {
            if (file != null && isGitPath(String(file))) return
            onActivity()
        })
    } catch {
        // Unwatchable roots lose only this signal; output still pets.
        return () => {}
    }
    watcher.unref()
    watcher.on("error", () => watcher.close())
    return () => watcher.close()
}

function isGitPath(file: string): boolean {
    return file.split(/[\\/]/u)[0] === ".git"
}

export interface StoryActivityGuardOptions {
    /** Worktree whose file changes count as activity. */
    cwd?: string
    idleMs?: number
    /** Explicit per-story `--timeout`; unset means no wall bound at all. */
    wallMs?: number
    label: string
    awakeClock?: AwakeClock
}

export interface StoryActivityGuard {
    pet(): void
    stop(): void
}

/** Fires `onTimeout` at most once, then stops itself. */
export function startStoryActivityGuard(
    opts: StoryActivityGuardOptions & {
        onTimeout: (error: StoryAttemptTimeoutError) => void
    },
): StoryActivityGuard {
    const idleMs = opts.idleMs ?? activityIdleTimeoutMs()
    let stopped = false
    const fire = (message: string): void => {
        if (stopped) return
        stop()
        opts.onTimeout(new StoryAttemptTimeoutError(message))
    }
    const watchdog = startActivityWatchdog({
        idleMs,
        onIdle: () =>
            fire(`${opts.label} showed no activity for ${idleMs / 1000}s`),
        ...(opts.awakeClock ? { awakeClock: opts.awakeClock } : {}),
    })
    const unwatch = opts.cwd
        ? watchWorktreeActivity(opts.cwd, () => watchdog.pet())
        : () => {}
    const wallMs = opts.wallMs
    const wall =
        wallMs !== undefined && wallMs > 0
            ? createAwakeDeadline({
                  budget: "harness-liveness",
                  timeoutMs: wallMs,
                  onExpired: () =>
                      fire(`${opts.label} exceeded its ${wallMs / 1000}s timeout`),
                  ...(opts.awakeClock ? { clock: opts.awakeClock } : {}),
              })
            : null
    function stop(): void {
        if (stopped) return
        stopped = true
        watchdog.stop()
        unwatch()
        wall?.close()
    }
    return { pet: () => watchdog.pet(), stop }
}

/** Settles with the source unless the guard fires first; every output event
 *  of the source pets the watchdog alongside worktree file changes. */
export function raceWithStoryActivity<T>(
    source: { done: Promise<T>; onActivity: (() => void) | null },
    opts: StoryActivityGuardOptions,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const settle = (fn: () => void): void => {
            guard.stop()
            source.onActivity = null
            fn()
        }
        const guard = startStoryActivityGuard({
            ...opts,
            onTimeout: (error) => settle(() => reject(error)),
        })
        source.onActivity = () => guard.pet()
        source.done.then(
            (value) => settle(() => resolve(value)),
            (error: unknown) => settle(() => reject(error)),
        )
    })
}

/** `--timeout` 0 or unset means "no wall bound", not "expire immediately". */
export function wallBoundMs(timeoutSecs: number | undefined): number | undefined {
    return timeoutSecs !== undefined && timeoutSecs > 0
        ? timeoutSecs * 1000
        : undefined
}
