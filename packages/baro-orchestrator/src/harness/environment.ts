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

export function harnessChildEnvironment(
    source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
    const child = { ...source }
    for (const key of BARO_INTERNAL_HOST_KEYS) delete child[key]
    if (child[BARO_JIGJOY_ENV_MARKER] !== "1") return child
    for (const key of BARO_OWNED_GATEWAY_KEYS) delete child[key]
    return child
}
