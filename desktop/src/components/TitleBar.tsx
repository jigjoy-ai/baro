import { Play, Radio, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import type { Phase } from "@/protocol"
import type { RunMode } from "@/hooks/useSession"

export function TitleBar({
    phase, done, total, prUrl, mode, running, projectName, onReplay, onStop,
}: {
    phase: Phase
    done: number
    total: number
    prUrl: string | null
    mode: RunMode
    running: boolean
    projectName: string | null
    onReplay: () => void
    onStop: () => void
}) {
    return (
        <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
            {/* brand */}
            <div className="flex items-baseline gap-1">
                <span className="inline-block h-2 w-2 translate-y-[-1px] rounded-[2px] bg-baro" />
                <span className="font-semibold tracking-tight text-baro">baro</span>
                <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">UI</span>
            </div>

            {/* active project / run context */}
            <span className="truncate text-sm text-muted-foreground">
                {projectName ?? "no project selected"}
            </span>
            {phase !== "idle" && (
                <span className="hidden text-xs text-muted-foreground/70 sm:inline">
                    · {phase} {total > 0 && `· ${done}/${total}`}
                </span>
            )}

            {/* run controls */}
            <div className="ml-auto flex items-center gap-2">
                {mode === "mock" && <Badge variant="outline" className="text-baro">MOCK</Badge>}
                {prUrl && (
                    <a className="text-sm text-baro hover:underline" href={prUrl} target="_blank" rel="noreferrer">
                        PR ↗
                    </a>
                )}
                {running ? (
                    <Button size="sm" variant="destructive" onClick={onStop}>
                        <Square className="fill-current" /> Stop
                    </Button>
                ) : (
                    <Button size="sm" variant="outline" onClick={onReplay}>
                        <Play /> Replay demo
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="outline"
                    disabled
                    title="Live tail of ~/.baro/runs needs the backend (not in this build)"
                >
                    <Radio /> Tail live
                </Button>
            </div>
        </header>
    )
}
