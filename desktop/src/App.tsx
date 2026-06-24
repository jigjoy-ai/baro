import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useSession } from "@/hooks/useSession"
import { TitleBar } from "@/components/TitleBar"
import { StatusBar } from "@/components/StatusBar"
import { StartView } from "@/components/StartView"
import { ChatPanel } from "@/components/ChatPanel"
import { DagPanel } from "@/components/DagPanel"
import { RunOverview } from "@/components/RunOverview"
import { DoneSummary } from "@/components/DoneSummary"

export default function App() {
    const s = useSession()
    useEffect(() => { document.documentElement.classList.add("dark") }, [])

    const done = s.stories.filter((x) => s.status[x.id] === "done").length
    const total = s.stories.length
    const running = s.stories.filter((x) => s.status[x.id] === "running").map((x) => x.id)

    let activity: { text: string; busy: boolean } | null = null
    if (s.planStatus === "planning") activity = { text: `Planning with ${s.plannerModel}…`, busy: true }
    else if (s.planStatus === "refining") activity = { text: "Refining the plan…", busy: true }
    else if (s.phase === "executing") {
        activity = running.length
            ? { text: `Running ${running.join(", ")}`, busy: true }
            : { text: "Waiting for the next story…", busy: true }
    } else if (s.phase === "done") {
        activity = { text: s.doneInfo?.success ? "Done" : "Failed", busy: false }
    }

    const placeholder = s.phase === "planning" ? "refine the plan…"
        : (s.target ?? running[0]) ? `message ${s.target ?? running[0]}…`
        : "click a running story to message it…"

    async function newRun() {
        try { await invoke("stop_session") } catch { /* no live session */ }
        location.reload()
    }

    return (
        <div className="flex h-screen flex-col bg-background text-foreground">
            <TitleBar
                phase={s.phase}
                done={done}
                total={total}
                prUrl={s.prUrl}
                mode={s.mode}
                running={s.running}
                projectName={s.phase === "idle" ? null : s.doneInfo ? "booking-service" : "current run"}
                onReplay={s.replayDemo}
                onStop={s.stop}
            />

            {s.phase === "idle" ? (
                <StartView onStart={s.start} />
            ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                    {s.phase === "done" && s.doneInfo && (
                        <DoneSummary info={s.doneInfo} tokens={s.tokens} prUrl={s.prUrl} onNewRun={newRun} />
                    )}
                    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                        <ResizablePanel defaultSize="34%" minSize="24%">
                            <div className="h-full p-3 pr-1.5">
                                <ChatPanel
                                    chat={s.chat}
                                    planStatus={s.planStatus}
                                    placeholder={placeholder}
                                    onSend={(t) => s.sendMessage(t, s.phase)}
                                />
                            </div>
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel defaultSize="42%" minSize="30%">
                            <div className="h-full p-3 px-1.5">
                                <DagPanel
                                    levels={s.levels}
                                    stories={s.stories}
                                    status={s.status}
                                    lastLine={s.lastLine}
                                    phase={s.phase}
                                    target={s.target}
                                    feed={s.feed}
                                    onSelect={s.setTarget}
                                    onRun={s.run}
                                />
                            </div>
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel defaultSize="24%" minSize="18%">
                            <div className="h-full p-3 pl-1.5">
                                <RunOverview
                                    phase={s.phase}
                                    levels={s.levels}
                                    stories={s.stories}
                                    status={s.status}
                                    done={done}
                                    total={total}
                                    prUrl={s.prUrl}
                                />
                            </div>
                        </ResizablePanel>
                    </ResizablePanelGroup>
                </div>
            )}

            <StatusBar
                activity={activity}
                backend={s.backend}
                plannerModel={s.plannerModel}
                tokens={s.tokens}
                done={done}
                total={total}
                elapsedSecs={s.phase === "done" ? (s.doneInfo?.totalSecs ?? s.elapsedSecs) : s.elapsedSecs}
            />
        </div>
    )
}
