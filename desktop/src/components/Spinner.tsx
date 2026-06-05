/** Tiny spinner with a subtle baro-orange leading edge. */
export function Spinner({ className = "" }: { className?: string }) {
    return (
        <span
            className={`inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-baro ${className}`}
        />
    )
}
