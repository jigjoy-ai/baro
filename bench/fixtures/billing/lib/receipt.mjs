import { formatCents, toCents } from "./money.mjs"

export function receiptLine(label, amount) {
    return `${label}: ${formatCents(toCents(amount))}`
}
