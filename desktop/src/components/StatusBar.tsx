import type { Tokens } from "@/protocol"
import { Spinner } from "./Spinner"

function fmt(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
    return String(n)
}

function clock(secs: number): string {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}:${String(s).padStart(2, "0")}`
}

/** VS Code-style bottom bar: current activity on the left, run facts on the right. */
export function StatusBar({
    activity, backend, plannerModel, tokens, done, total, elapsedSecs,
}: {
    activity: { text: string; busy: boolean } | null
    backend: string
    plannerModel: string
    tokens: Tokens
    done: number
    total: number
    elapsedSecs: number
}) {
    return (
        <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-muted/30 px-3 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
                {activity?.busy && <Spinner />}
                <span className="truncate">{activity?.text ?? "ready"}</span>
            </div>
            <div className="ml-auto flex items-center gap-3">
                <Item label="backend" value={backend} />
                <Item label="planner" value={plannerModel} />
                <Item label="tok" value={`${fmt(tokens.input)}↓ ${fmt(tokens.output)}↑`} />
                <Item label="stories" value={`${done}/${total}`} />
                <span className="tabular-nums text-baro">{clock(elapsedSecs)}</span>
            </div>
        </footer>
    )
}

function Item({ label, value }: { label: string; value: string }) {
    return (
        <span className="tabular-nums">
            <span className="opacity-50">{label} </span>{value}
        </span>
    )
}
