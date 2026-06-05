import type { Phase } from "@/protocol"

export function TitleBar({
    phase, done, total, prUrl,
}: {
    phase: Phase
    done: number
    total: number
    prUrl: string | null
}) {
    return (
        <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
            <div className="flex items-baseline gap-2">
                {/* subtle baro-orange brand dot */}
                <span className="inline-block h-2 w-2 translate-y-[-1px] rounded-[2px] bg-baro" />
                <span className="font-semibold tracking-tight">BDE</span>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                    Baro Development Environment
                </span>
            </div>
            <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
                {phase !== "idle" && <span>{phase} · {done}/{total}</span>}
                {prUrl && (
                    <a className="text-baro hover:underline" href={prUrl} target="_blank" rel="noreferrer">
                        PR ↗
                    </a>
                )}
            </div>
        </header>
    )
}
