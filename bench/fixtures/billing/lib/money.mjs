// Amounts are integer cents.
export function toCents(amount) {
    return Math.floor(amount * 100)
}

export function formatCents(cents) {
    const euros = Math.floor(cents / 100)
    const rest = String(cents % 100).padStart(2, "0")
    return `${euros}.${rest} EUR`
}
