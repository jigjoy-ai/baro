/**
 * Keep subscription-backed CLI harnesses independent from credentials that
 * Baro's Rust JigJoy preset injected for OpenAI-compatible Gateway phases.
 *
 * The marker is essential: ordinary user-provided environment is preserved
 * byte-for-byte. We sanitize only values whose ownership is explicitly Baro's
 * current process, so standalone Claude Code/Codex/OpenCode/Pi configuration
 * remains backward-compatible.
 */

export const BARO_JIGJOY_ENV_MARKER = "BARO_JIGJOY_ENV_INJECTED"

const BARO_OWNED_GATEWAY_KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "JIGJOY_API_KEY",
    "BARO_JIGJOY_URL",
    "BARO_GATEWAY_BILLING_URL",
    "BARO_GATEWAY_BILLING_API_KEY",
    BARO_JIGJOY_ENV_MARKER,
] as const

const BARO_INTERNAL_HOST_KEYS = [
    "BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST",
    "BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN",
] as const

/**
 * The CLI default truncates a shell command well below the runtime of an
 * ordinary test suite, so a story backgrounds its own verification and spends
 * its turn polling for it. A value the user set is theirs and is left alone.
 */
const CHILD_SHELL_TIMEOUTS: Readonly<Record<string, string>> = {
    BASH_DEFAULT_TIMEOUT_MS: "900000",
    BASH_MAX_TIMEOUT_MS: "3600000",
}

export function harnessChildEnvironment(
    source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
    const child = { ...source }
    for (const key of BARO_INTERNAL_HOST_KEYS) delete child[key]
    for (const [key, value] of Object.entries(CHILD_SHELL_TIMEOUTS)) {
        if (child[key] === undefined) child[key] = value
    }
    if (child[BARO_JIGJOY_ENV_MARKER] !== "1") return child
    for (const key of BARO_OWNED_GATEWAY_KEYS) delete child[key]
    return child
}
