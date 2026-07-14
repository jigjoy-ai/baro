import {
    GatewayBillingCoordinator,
    type BillingMeasurementPublisher,
    type GatewayBillingCoordinatorOptions,
    type GatewayBillingDrainResult,
} from "./gateway-billing-coordinator.js"

export interface GatewayBillingEnvironment {
    readonly gatewayBaseUrl: string
    readonly apiKey: string
}

/**
 * Resolve billing authority from an explicit opt-in only. OPENAI_BASE_URL by
 * itself is deliberately irrelevant so generic OpenAI-compatible endpoints,
 * Claude Code, Codex, OpenCode, and Pi retain their existing local behavior.
 */
export function resolveGatewayBillingEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
): GatewayBillingEnvironment | null {
    const configured = environment.BARO_GATEWAY_BILLING_URL
    if (configured === undefined || configured.trim().length === 0) return null
    const apiKey =
        environment.BARO_GATEWAY_BILLING_API_KEY ??
        environment.JIGJOY_API_KEY ??
        environment.OPENAI_API_KEY
    if (!apiKey) {
        throw new Error(
            "BARO_GATEWAY_BILLING_URL requires BARO_GATEWAY_BILLING_API_KEY, JIGJOY_API_KEY, or OPENAI_API_KEY",
        )
    }
    return Object.freeze({
        gatewayBaseUrl: configured.trim(),
        apiKey,
    })
}

export function createGatewayBillingCoordinatorFromEnv(options: {
    readonly runId: string
    readonly publishMeasurement: BillingMeasurementPublisher
    readonly environment?: NodeJS.ProcessEnv
    readonly coordinatorOptions?: Omit<
        GatewayBillingCoordinatorOptions,
        "runId" | "gatewayBaseUrl" | "apiKey" | "publishMeasurement"
    >
}): GatewayBillingCoordinator | null {
    const resolved = resolveGatewayBillingEnvironment(options.environment)
    if (!resolved) return null
    return new GatewayBillingCoordinator({
        ...options.coordinatorOptions,
        ...resolved,
        runId: options.runId,
        publishMeasurement: options.publishMeasurement,
    })
}

/** Always close, including when reconciliation itself fails. */
export async function reconcileAndCloseGatewayBilling(
    coordinator: GatewayBillingCoordinator | null,
): Promise<GatewayBillingDrainResult | null> {
    if (!coordinator) return null
    try {
        return await coordinator.drain()
    } finally {
        coordinator.close()
    }
}
