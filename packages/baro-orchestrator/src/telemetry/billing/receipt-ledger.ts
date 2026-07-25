import {
    knownMetric,
    notApplicableMetric,
    unknownMetric,
    type Metric,
    type ModelInvocationGranularity,
    type ModelInvocationMeasuredData,
} from "../model-telemetry.js"
import {
    billingMoneyToUsd,
    parseCloudBillingReceipt,
    type BillingMoney,
    type CloudBillingReceipt,
} from "./cloud-receipt.js"
import {
    BillingInvocationRegistry,
    type BillingInvocationRecord,
    type TrustedGatewayIdentity,
} from "./invocation-registry.js"

export type BillingReceiptIngestionResult =
    | {
          readonly state: "accepted"
          readonly receipt: CloudBillingReceipt
          readonly measurement: ModelInvocationMeasuredData
      }
    | {
          readonly state: "replay"
          readonly receiptId: string
      }

/**
 * Turn an authoritative cloud receipt into the existing telemetry contract.
 * Correlation and execution dimensions always come from the pre-dispatch
 * local registry record, never from cloud payload fields.
 */
export function mapCloudBillingReceipt(
    value: CloudBillingReceipt,
    record: BillingInvocationRecord,
): ModelInvocationMeasuredData {
    const receipt = parseCloudBillingReceipt(value)
    if (
        receipt.billingSessionId !== record.billingSessionId ||
        receipt.invocationId !== record.invocationId
    ) {
        throw new BillingReceiptConflictError(
            "receipt does not match the local billing invocation authority",
        )
    }
    if (
        record.requestedModel !== null &&
        receipt.requestedModel !== record.requestedModel
    ) {
        throw new BillingReceiptConflictError(
            "gateway requestedModel conflicts with the local dispatch record",
        )
    }

    const missing = () => unknownMetric("not_reported")
    const token = (value: number | null): Metric =>
        value === null ? missing() : knownMetric(value, "gateway_receipt")
    const complete = receipt.metering === "complete"
    const measurement: ModelInvocationMeasuredData = {
        schemaVersion: 1,
        measurementId: `billing:${receipt.receiptId}`,
        invocationId: record.invocationId,
        runId: record.runId,
        phase: record.phase,
        storyId: record.storyId,
        leaseId: record.leaseId,
        generation: record.generation,
        attempt: record.attempt,
        turn: record.turn,
        round: record.round,
        backend: record.backend,
        provider: receipt.provider,
        requestedModel: record.requestedModel,
        resolvedModel: receipt.resolvedModel,
        // This observation says the cloud metering operation settled. Runtime
        // success/failure remains authoritative in the runner observation.
        status: "succeeded",
        durationMs: missing(),
        tokens: {
            inputTotal: token(receipt.tokens.inputTotal),
            cachedInput: token(receipt.tokens.cachedInput),
            cacheWriteInput: token(receipt.tokens.cacheWriteInput),
            outputTotal: token(receipt.tokens.outputTotal),
            reasoningOutput: token(receipt.tokens.reasoningOutput),
            total: token(receipt.tokens.total),
        },
        cost: {
            providerUsd:
                complete && receipt.providerCost !== null
                    ? moneyMetric(receipt.providerCost, "gateway_rate_card")
                    : missing(),
            customerUsd: complete
                ? moneyMetric(receipt.customerCost, "cloud_charge")
                : missing(),
            equivalentUsd: notApplicableMetric(),
        },
        evidence: {
            producer: "cloud",
            providerRequestId: receipt.providerRequestId,
            rateCardVersion: receipt.rateCardVersion,
            granularity: localGranularity(record),
        },
    }
    return deepFreeze(measurement)
}

/**
 * In-memory exactly-once decision ledger for one billing session.
 *
 * A byte-equivalent canonical replay is ignored. Reusing either a receipt ID,
 * charge ID, or invocation finality for different data fails closed.
 */
export class BillingReceiptLedger {
    private readonly byReceiptId = new Map<
        string,
        { readonly canonical: string; readonly invocationId: string }
    >()
    private readonly receiptByInvocation = new Map<string, string>()
    private readonly receiptByCharge = new Map<string, string>()

    constructor(private readonly registry: BillingInvocationRegistry) {}

    get size(): number {
        return this.byReceiptId.size
    }

    ingest(
        value: CloudBillingReceipt,
        sourceGateway: TrustedGatewayIdentity,
    ): BillingReceiptIngestionResult {
        const receipt = parseCloudBillingReceipt(value)
        // Authenticate source/session/invocation even for an otherwise exact
        // replay; replay idempotency must not become an authority bypass.
        const record = this.registry.requireForReceipt(receipt, sourceGateway)
        const canonical = JSON.stringify(receipt)
        const previous = this.byReceiptId.get(receipt.receiptId)
        if (previous) {
            if (previous.canonical !== canonical) {
                throw new BillingReceiptConflictError(
                    "receiptId was replayed with mutated final data",
                )
            }
            return Object.freeze({ state: "replay", receiptId: receipt.receiptId })
        }

        const existingInvocation = this.receiptByInvocation.get(receipt.invocationId)
        if (existingInvocation) {
            throw new BillingReceiptConflictError(
                `invocation already has final receipt ${existingInvocation}`,
            )
        }
        const existingCharge = this.receiptByCharge.get(receipt.chargeId)
        if (existingCharge) {
            throw new BillingReceiptConflictError(
                `chargeId already belongs to receipt ${existingCharge}`,
            )
        }

        const measurement = mapCloudBillingReceipt(receipt, record)

        // Commit only after validation and mapping have both completed.
        this.byReceiptId.set(receipt.receiptId, {
            canonical,
            invocationId: receipt.invocationId,
        })
        this.receiptByInvocation.set(receipt.invocationId, receipt.receiptId)
        this.receiptByCharge.set(receipt.chargeId, receipt.receiptId)
        return deepFreeze({ state: "accepted", receipt, measurement })
    }
}

export class BillingReceiptConflictError extends Error {
    override readonly name = "BillingReceiptConflictError"
}

function moneyMetric(
    money: BillingMoney,
    source: "gateway_rate_card" | "cloud_charge",
): Metric {
    return knownMetric(billingMoneyToUsd(money), source)
}

function localGranularity(record: BillingInvocationRecord): ModelInvocationGranularity {
    if (record.round !== null) return "round"
    if (record.turn !== null) return "turn"
    return "process"
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    return Object.freeze(value)
}
