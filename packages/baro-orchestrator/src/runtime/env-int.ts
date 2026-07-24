/** Non-negative integer from the environment, else the fallback. */
export function envNonNegativeInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw == null || raw.trim() === "") return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}
