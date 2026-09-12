/**
 * Idle-based watchdog policy. A subprocess that streams output is alive; one
 * that has gone silent for the whole window is presumed hung. Wall-clock
 * total caps killed legitimately long work (run 12's planner died 8 minutes
 * into a productive turn, right after publishing a fragment); silence is the
 * only signal that distinguishes "thinking long" from "dead".
 */

import {
    createAwakeDeadline,
    sharedAwakeClock,
    type AwakeClock,
    type AwakeDeadline,
} from "../runtime/awake-clock.js"

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
 *  window. Inert after dispose(). The window is measured in awake time, so a
 *  suspended laptop is not silence the subprocess is answerable for. */
export class IdleWatchdog {
    private deadline: AwakeDeadline | undefined
    private disposed = false

    constructor(
        private readonly idleMs: number,
        private readonly onIdle: () => void,
        private readonly clock: AwakeClock = sharedAwakeClock(),
    ) {
        this.pet()
    }

    pet(): void {
        if (this.disposed || this.idleMs <= 0) return
        this.deadline?.close()
        this.deadline = createAwakeDeadline({
            budget: "harness-liveness",
            timeoutMs: this.idleMs,
            onExpired: () => {
                if (!this.disposed) this.onIdle()
            },
            clock: this.clock,
        })
    }

    dispose(): void {
        this.disposed = true
        this.deadline?.close()
        this.deadline = undefined
    }
}
