import { Check, ExternalLink } from "lucide-react"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Spinner } from "./Spinner"
import { statusColor, type DraftStory, type Phase, type StoryStatus } from "@/protocol"

const STEPS = ["Architect", "Planner", "Execute", "Review"] as const

/** Index of the step currently in flight (-1 = nothing running yet). */
function activeStep(phase: Phase): number {
    switch (phase) {
        case "planning": return 1
        case "executing": return 2
        case "done": return STEPS.length // everything behind us
        default: return -1
    }
}

export function RunOverview({
    phase, levels, stories, status, done, total, prUrl,
}: {
    phase: Phase
    levels: { id: string; model: string }[][]
    stories: DraftStory[]
    status: Record<string, StoryStatus>
    done: number
    total: number
    prUrl: string | null
}) {
    const cur = activeStep(phase)
    const heading = phase === "done" ? "Run complete"
        : phase === "executing" ? "Run in progress"
        : levels.length ? "Plan ready"
        : "No active run"
    const pct = total > 0 ? Math.round((done / total) * 100) : 0

    return (
        <Card className="flex h-full min-h-0 flex-col gap-0 p-0">
            <div className="border-b px-4 py-3">
                <h2 className="text-sm font-semibold">{heading}</h2>
                {/* phase stepper */}
                <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                    {STEPS.map((label, i) => {
                        const stepDone = cur > i
                        const stepActive = cur === i
                        return (
                            <span key={label} className="flex items-center gap-1.5">
                                {i > 0 && <span className="text-muted-foreground/40">→</span>}
                                <span className="flex items-center gap-1">
                                    {stepDone ? <Check className="h-3 w-3 text-baro" />
                                        : stepActive ? <Spinner />
                                        : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />}
                                    <span className={stepDone ? "text-foreground"
                                        : stepActive ? "text-baro"
                                        : "text-muted-foreground/50"}>
                                        {label}
                                    </span>
                                </span>
                            </span>
                        )
                    })}
                </div>

                {total > 0 && (
                    <div className="mt-3">
                        <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                            <span>{done}/{total} stories</span>
                            <span className="tabular-nums">{pct}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-baro transition-all" style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                )}
            </div>

            <ScrollArea className="min-h-0 flex-1 p-4">
                {levels.length === 0 ? (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                        The story DAG appears here once the Planner decomposes the goal.
                    </p>
                ) : (
                    <div className="space-y-4">
                        {levels.map((lvl, li) => (
                            <div key={li}>
                                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                                    Level {li + 1}
                                </div>
                                <div className="space-y-1.5">
                                    {lvl.map((n) => {
                                        const st = status[n.id] ?? "queued"
                                        const title = stories.find((s) => s.id === n.id)?.title ?? n.id
                                        return (
                                            <div key={n.id} className="flex items-center gap-2 text-xs">
                                                <span
                                                    className={`h-2 w-2 shrink-0 rounded-full ${st === "running" ? "animate-pulse" : ""}`}
                                                    style={{ background: statusColor(st) }}
                                                />
                                                <span className="font-medium text-muted-foreground">{n.id}</span>
                                                <span className="truncate text-foreground/80">{title}</span>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </ScrollArea>

            {prUrl && (
                <div className="border-t p-3">
                    <Button asChild className="w-full bg-baro text-black hover:bg-baro/90">
                        <a href={prUrl} target="_blank" rel="noreferrer">
                            <ExternalLink /> Open pull request
                        </a>
                    </Button>
                </div>
            )}
        </Card>
    )
}
