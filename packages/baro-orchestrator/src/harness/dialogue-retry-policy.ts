/**
 * Retry policy for the pre-planning conversation/intake dialogue.
 *
 * The dialogue is the one call a user is actively waiting on, and a provider
 * cooldown there ends the session rather than a story: it is worth several
 * patient minutes where the batch phases fail fast. The numbers and the two
 * environment variable names live here alone so the entry script, the stderr
 * notice and the tests cannot disagree about them.
 */

export interface DialogueRetryPolicy {
    maxAttempts: number
    maxWaitMs: number
    fallbackWaitMs: number
}

export const DIALOGUE_RETRY_ATTEMPTS_ENV = "BARO_DIALOGUE_RETRY_ATTEMPTS"
export const DIALOGUE_RETRY_MAX_WAIT_MS_ENV = "BARO_DIALOGUE_RETRY_MAX_WAIT_MS"

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_MAX_WAIT_MS = 120_000
/** Not env-overridable: the ceiling is the knob operators reach for. */
const FALLBACK_WAIT_MS = 15_000

const MIN_ATTEMPTS = 1
const MAX_ATTEMPTS = 8
const MIN_MAX_WAIT_MS = 1_000
const MAX_MAX_WAIT_MS = 600_000

export function resolveDialogueRetryPolicy(
    env: NodeJS.ProcessEnv = process.env,
): DialogueRetryPolicy {
    return {
        maxAttempts: clamp(
            parseInteger(env[DIALOGUE_RETRY_ATTEMPTS_ENV], DEFAULT_MAX_ATTEMPTS),
            MIN_ATTEMPTS,
            MAX_ATTEMPTS,
        ),
        maxWaitMs: clamp(
            parseInteger(env[DIALOGUE_RETRY_MAX_WAIT_MS_ENV], DEFAULT_MAX_WAIT_MS),
            MIN_MAX_WAIT_MS,
            MAX_MAX_WAIT_MS,
        ),
        fallbackWaitMs: FALLBACK_WAIT_MS,
    }
}

/** A typo must degrade to the default, never to zero attempts. */
function parseInteger(raw: string | undefined, fallback: number): number {
    if (raw == null || raw.trim() === "") return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return fallback
    return Math.floor(value) === value ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}
