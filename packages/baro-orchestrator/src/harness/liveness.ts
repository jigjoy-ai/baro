/**
 * Idle-based watchdog policy. A subprocess that streams output is alive; one
 * that has gone silent for the whole window is presumed hung. Wall-clock
 * total caps killed legitimately long work (run 12's planner died 8 minutes
 * into a productive turn, right after publishing a fragment); silence is the
 * only signal that distinguishes "thinking long" from "dead".
 */

function envSecs(name: string, fallbackSecs: number): number {
    const raw = process.env[name]
    if (raw !== undefined) {
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000
    }
    return fallbackSecs * 1000
}

/** LLM CLI turns stream per-token/per-event lines; minutes of total silence
 *  means a stalled API call or a dead process, not thought. */
export function llmIdleTimeoutMs(): number {
    return envSecs("BARO_LLM_IDLE_TIMEOUT_SECS", 180)
}

/** Build/test/git subprocesses may legitimately compile in silence for a
 *  while, so their window is wider. */
export function commandIdleTimeoutMs(): number {
    return envSecs("BARO_COMMAND_IDLE_TIMEOUT_SECS", 300)
}

/** Re-armable idle timer for call sites that don't go through execFileCli.
 *  `pet()` on every proof of life; `onIdle` fires only after a full silent
 *  window. Inert after dispose(). */
export class IdleWatchdog {
    private timer: ReturnType<typeof setTimeout> | undefined
    private disposed = false

    constructor(
        private readonly idleMs: number,
        private readonly onIdle: () => void,
    ) {
        this.pet()
    }

    pet(): void {
        if (this.disposed || this.idleMs <= 0) return
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            if (!this.disposed) this.onIdle()
        }, this.idleMs)
    }

    dispose(): void {
        this.disposed = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
    }
}
