import type { StoryRoute } from "../routing.js"
import {
    resolveGatewayBillingEnvironment,
    type GatewayBillingEnvironment,
} from "./gateway-billing-env.js"
import { createTrustedGatewayIdentity } from "./invocation-registry.js"

export interface GatewayBillingActivationOptions {
    readonly environment?: Readonly<NodeJS.ProcessEnv>
    readonly routes: readonly StoryRoute[]
    readonly defaultOpenAiBaseUrl?: string
    readonly defaultOpenAiApiKey?: string
}

/**
 * Resolve billing only when a concrete OpenAI route targets the explicitly
 * configured Gateway. Stale billing env must never break an all-harness run,
 * and a different OpenAI-compatible endpoint must never inherit authority.
 */
export function resolveGatewayBillingForRoutes(
    options: GatewayBillingActivationOptions,
): GatewayBillingEnvironment | null {
    const environment = options.environment ?? process.env
    const configured = environment.BARO_GATEWAY_BILLING_URL
    if (!configured) return null

    const openAiRoutes = options.routes.filter(
        (route) =>
            route.backend === "openai" &&
            Boolean(route.baseUrl ?? options.defaultOpenAiBaseUrl),
    )
    // Do not even parse stale Gateway configuration when no route can use it.
    if (openAiRoutes.length === 0) return null

    const gateway = createTrustedGatewayIdentity(configured)
    const matchingCredentials = new Set<string>()
    let matches = 0
    for (const route of openAiRoutes) {
        const effectiveBaseUrl = route.baseUrl ?? options.defaultOpenAiBaseUrl
        if (!effectiveBaseUrl) continue
        const candidate = createTrustedGatewayIdentity(effectiveBaseUrl)
        if (candidate.baseUrl !== gateway.baseUrl) continue
        matches += 1
        const credential = route.apiKey ?? options.defaultOpenAiApiKey
        if (credential) matchingCredentials.add(credential)
    }
    if (matches === 0) return null
    if (matchingCredentials.size > 1) {
        throw new Error(
            "the configured billing Gateway is targeted with multiple credentials",
        )
    }

    const routeCredential = matchingCredentials.values().next().value as
        | string
        | undefined
    const explicitCredential = environment.BARO_GATEWAY_BILLING_API_KEY
    if (
        explicitCredential &&
        routeCredential &&
        explicitCredential !== routeCredential
    ) {
        throw new Error(
            "BARO_GATEWAY_BILLING_API_KEY does not match the model route credential",
        )
    }

    const resolved = resolveGatewayBillingEnvironment({
        ...environment,
        ...(explicitCredential || !routeCredential
            ? {}
            : { BARO_GATEWAY_BILLING_API_KEY: routeCredential }),
    })
    if (!resolved) return null
    if (routeCredential && resolved.apiKey !== routeCredential) {
        throw new Error(
            "billing Gateway credential does not match the model route credential",
        )
    }
    return resolved
}
