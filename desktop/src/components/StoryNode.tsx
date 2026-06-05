import { statusColor, tierColor, type Phase, type StoryStatus } from "@/protocol"

export function StoryNode({
    id, model, title, st, phase, selectable, selected, lastLine, onSelect,
}: {
    id: string
    model: string
    title: string
    st: StoryStatus
    phase: Phase
    selectable: boolean
    selected: boolean
    lastLine?: string
    onSelect: () => void
}) {
    const running = st === "running"
    return (
        <div
            title={title}
            onClick={selectable ? onSelect : undefined}
            className={[
                "flex w-56 min-w-0 flex-col gap-1 rounded-md border bg-card px-2 py-1.5 text-xs transition-colors",
                running ? "border-baro/70 shadow-[0_0_0_1px_rgba(255,181,71,0.35)]" : "",
                selectable ? "cursor-pointer hover:border-foreground/30" : "",
                selected ? "ring-2 ring-baro" : "",
            ].join(" ")}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                {phase !== "planning" && (
                    <span
                        className={`h-2 w-2 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
                        style={{ background: statusColor(st) }}
                    />
                )}
                <span className="font-medium">{id}</span>
                <span className="truncate" style={{ color: tierColor(model) }}>{model}</span>
            </div>
            <span className="line-clamp-2 text-muted-foreground/70">{title}</span>
            {/* reserved fixed-height row so the card doesn't jump as the stream updates */}
            <span className="block h-3.5 truncate font-mono text-[10px] text-baro/80">
                {running ? lastLine ?? "" : ""}
            </span>
        </div>
    )
}
