import { formatCents, toCents } from "./money.mjs"

export function invoiceTotal(lines) {
    const cents = lines.reduce((sum, line) => sum + toCents(line.price) * line.quantity, 0)
    return formatCents(cents)
}
