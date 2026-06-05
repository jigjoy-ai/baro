import { Button } from "@/components/ui/button"
import type { DoneInfo, Tokens } from "@/protocol"

function fmt(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
    return String(n)
}

/** Result banner shown above the panels once the run settles. */
export function DoneSummary({
    info, tokens, prUrl, onNewRun,
}: {
    info: DoneInfo
    tokens: Tokens
    prUrl: string | null
    onNewRun: () => void
}) {
    const mins = Math.floor(info.totalSecs / 60)
    const secs = info.totalSecs % 60
    return (
        <div className={[
            "flex shrink-0 items-center gap-4 border-b px-4 py-2.5 text-sm",
            info.success ? "bg-baro-soft" : "bg-destructive/10",
        ].join(" ")}>
            <span className={`font-semibold ${info.success ? "text-baro" : "text-destructive"}`}>
                {info.success ? "✓ Run complete" : "✕ Run failed"}
            </span>
            <span className="text-muted-foreground">
                {info.done}/{info.total} stories · {mins}m {secs}s · {fmt(tokens.input)}↓ {fmt(tokens.output)}↑ tokens
            </span>
            {prUrl && (
                <a className="text-baro hover:underline" href={prUrl} target="_blank" rel="noreferrer">
                    open PR ↗
                </a>
            )}
            <Button size="sm" variant="outline" className="ml-auto" onClick={onNewRun}>
                New run
            </Button>
        </div>
    )
}
