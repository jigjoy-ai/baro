import { useEffect, useRef } from "react"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import type { DraftStory, Phase, StoryStatus } from "@/protocol"
import { StoryNode } from "./StoryNode"

export function DagPanel({
    levels, stories, status, lastLine, phase, target, feed, onSelect, onRun,
}: {
    levels: { id: string; model: string }[][]
    stories: DraftStory[]
    status: Record<string, StoryStatus>
    lastLine: Record<string, string>
    phase: Phase
    target: string | null
    feed: { id: string; line: string }[]
    onSelect: (id: string) => void
    onRun: () => void
}) {
    const feedRef = useRef<HTMLDivElement>(null)
    useEffect(() => { feedRef.current?.scrollTo(0, feedRef.current.scrollHeight) }, [feed])

    return (
        <Card className="flex h-full min-h-0 flex-col gap-0 p-0">
            <div className="flex items-center justify-between border-b px-4 py-2">
                <span className="text-sm text-muted-foreground">
                    DAG {phase === "planning" ? "· draft (edit via chat)" : "· live"}
                </span>
                {phase === "planning" && (
                    <Button size="sm" onClick={onRun} className="bg-baro text-black hover:bg-baro/90">
                        ▶ RUN
                    </Button>
                )}
            </div>

            <ScrollArea className="min-h-0 flex-1 p-4">
                <div className="space-y-3">
                    {levels.map((lvl, li) => (
                        <div key={li} className="flex items-start gap-3">
                            <span className="mt-1 w-6 shrink-0 text-xs text-muted-foreground">L{li}</span>
                            <div className="flex flex-1 flex-wrap gap-2">
                                {lvl.map((n) => (
                                    <StoryNode
                                        key={n.id}
                                        id={n.id}
                                        model={n.model}
                                        title={stories.find((s) => s.id === n.id)?.title ?? n.id}
                                        st={status[n.id] ?? "queued"}
                                        phase={phase}
                                        selectable={phase === "executing"}
                                        selected={target === n.id}
                                        lastLine={lastLine[n.id]}
                                        onSelect={() => onSelect(n.id)}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </ScrollArea>

            <Separator />
            <div ref={feedRef} className="h-40 overflow-auto bg-muted/30 p-2 font-mono text-[11px] leading-snug">
                {feed.map((f, i) => (
                    <div key={i} className="flex gap-2">
                        <span className="shrink-0 text-muted-foreground/50">{f.id}</span>
                        <span className={f.line.startsWith("[tool") ? "text-sky-400/70" : "text-muted-foreground"}>
                            {f.line}
                        </span>
                    </div>
                ))}
            </div>
        </Card>
    )
}
