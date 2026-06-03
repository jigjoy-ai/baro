import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Send } from "lucide-react"
import {
    type DraftStory,
    type SessionEvent,
    type StoryStatus,
    statusColor,
    tierColor,
} from "./protocol"

type Phase = "idle" | "planning" | "executing" | "done"
type PlanStatus = "planning" | "refining" | "idle"
interface ChatMsg { role: "you" | "planner" | "error"; text: string }

/** Character-by-character reveal — animates a message in on mount. */
function Typed({ text, speed = 9 }: { text: string; speed?: number }) {
    const [n, setN] = useState(0)
    useEffect(() => {
        if (!text) return
        const id = setInterval(() => {
            setN((x) => {
                if (x >= text.length) {
                    clearInterval(id)
                    return x
                }
                return x + 2
            })
        }, speed)
        return () => clearInterval(id)
    }, [text, speed])
    const shown = text.slice(0, n)
    return (
        <span>
            {shown}
            {n < text.length && <span className="animate-pulse">▍</span>}
        </span>
    )
}

function Spinner() {
    return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground" />
    )
}

export default function App() {
    const [phase, setPhase] = useState<Phase>("idle")
    const [planStatus, setPlanStatus] = useState<PlanStatus>("idle")
    const [plannerModel, setPlannerModel] = useState("sonnet")
    const [goal, setGoal] = useState("")
    const [cwd, setCwd] = useState("")
    const [stories, setStories] = useState<DraftStory[]>([])
    const [levels, setLevels] = useState<{ id: string; model: string }[][]>([])
    const [status, setStatus] = useState<Record<string, StoryStatus>>({})
    const [lastLine, setLastLine] = useState<Record<string, string>>({})
    const [chat, setChat] = useState<ChatMsg[]>([])
    const [feed, setFeed] = useState<{ id: string; line: string }[]>([])
    const [draftMsg, setDraftMsg] = useState("")
    const [prUrl, setPrUrl] = useState<string | null>(null)
    const feedRef = useRef<HTMLDivElement>(null)
    const chatEndRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        document.documentElement.classList.add("dark")
        const subs = Promise.all([
            listen<string>("session-event", (e) => onEvent(e.payload)),
            listen<string>("session-log", (e) =>
                setFeed((f) => [...f.slice(-400), { id: "·", line: e.payload }]),
            ),
        ])
        return () => void subs.then((fns) => fns.forEach((f) => f()))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => { feedRef.current?.scrollTo(0, feedRef.current.scrollHeight) }, [feed])
    useEffect(() => { chatEndRef.current?.scrollIntoView({ block: "end" }) }, [chat, planStatus])

    function onEvent(raw: string) {
        let evt: SessionEvent
        try { evt = JSON.parse(raw) as SessionEvent } catch { return }
        switch (evt.type) {
            case "plan_status":
                setPlanStatus(evt.state)
                if (evt.model) setPlannerModel(evt.model)
                break
            case "plan_draft":
                setStories(evt.stories)
                setLevels(evt.levels)
                setPhase((p) => (p === "idle" ? "planning" : p))
                break
            case "plan_reply":
                setChat((c) => [...c, { role: "planner", text: evt.text }])
                break
            case "plan_error":
                setChat((c) => [...c, { role: "error", text: evt.text }])
                break
            case "plan_committed":
                setPhase("executing")
                setChat((c) => [...c, { role: "planner", text: "Plan committed — executing." }])
                break
            case "story_start":
                setStatus((s) => ({ ...s, [evt.id]: "running" }))
                break
            case "story_log":
                setLastLine((m) => ({ ...m, [evt.id]: evt.line }))
                setFeed((f) => [...f.slice(-400), { id: evt.id, line: evt.line }])
                break
            case "story_complete":
                setStatus((s) => ({ ...s, [evt.id]: "done" }))
                break
            case "story_error":
                setStatus((s) => ({ ...s, [evt.id]: "failed" }))
                break
            case "finalize_complete":
                setPrUrl(evt.pr_url)
                break
            case "done":
                setPhase("done")
                setChat((c) => [...c, {
                    role: "planner",
                    text: `Run ${evt.success ? "succeeded" : "failed"} in ${evt.total_time_secs}s.`,
                }])
                break
        }
    }

    async function start() {
        if (!goal.trim() || !cwd.trim()) return
        setChat([{ role: "you", text: goal }])
        try {
            await invoke("start_session", { args: { goal, cwd, planner_model: plannerModel, no_git: false } })
            setPhase("planning")
        } catch (e) {
            setChat((c) => [...c, { role: "error", text: String(e) }])
        }
    }

    async function send(line: object) {
        await invoke("send_command", { line: JSON.stringify(line) })
    }
    async function sendMessage() {
        const text = draftMsg.trim()
        if (!text) return
        setChat((c) => [...c, { role: "you", text }])
        setDraftMsg("")
        await send({ type: "plan_message", text })
    }

    const done = stories.filter((s) => status[s.id] === "done").length
    const running = stories.filter((s) => status[s.id] === "running").map((s) => s.id)

    // The "what's happening now" line.
    let activity: { text: string; busy: boolean } | null = null
    if (planStatus === "planning") activity = { text: `Planning with ${plannerModel}…`, busy: true }
    else if (planStatus === "refining") activity = { text: `Refining the plan…`, busy: true }
    else if (phase === "executing") {
        activity = running.length
            ? { text: `Running ${running.join(", ")}`, busy: true }
            : { text: "Waiting for the next story…", busy: true }
    } else if (phase === "done") activity = { text: "Done", busy: false }

    return (
        <div className="flex h-screen flex-col bg-background text-foreground">
            <header className="flex items-center gap-3 border-b px-4 py-2.5">
                <span className="font-semibold tracking-tight">baro</span>
                <span className="text-sm text-muted-foreground">
                    {phase === "idle" ? "new run" : `${phase} · ${done}/${stories.length}`}
                </span>
                <div className="ml-auto">
                    {prUrl && (
                        <a className="text-sm text-primary underline" href={prUrl} target="_blank" rel="noreferrer">PR ↗</a>
                    )}
                </div>
            </header>

            {/* live activity strip */}
            {activity && (
                <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5 text-sm">
                    {activity.busy && <Spinner />}
                    <span className={activity.busy ? "text-foreground" : "text-muted-foreground"}>{activity.text}</span>
                </div>
            )}

            {phase === "idle" ? (
                <div className="flex flex-1 items-center justify-center p-6">
                    <Card className="w-full max-w-xl space-y-4 p-6">
                        <h2 className="text-lg font-semibold">Start a run</h2>
                        <div className="space-y-1.5">
                            <label className="text-sm text-muted-foreground">Goal</label>
                            <Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)}
                                placeholder="Add a reservations module to the service…" />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-sm text-muted-foreground">Working directory</label>
                            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/target/repo" />
                        </div>
                        <Button onClick={start} disabled={!goal.trim() || !cwd.trim()} className="w-full">Plan it ▸</Button>
                    </Card>
                </div>
            ) : (
                <div className="grid flex-1 grid-cols-2 gap-3 overflow-hidden p-3">
                    {/* left — chat / steer */}
                    <Card className="flex min-h-0 flex-col p-0">
                        <ScrollArea className="min-h-0 flex-1 p-4">
                            <div className="space-y-3">
                                {chat.map((m, i) => (
                                    <div key={i} className="text-sm leading-relaxed">
                                        <span className="mr-2 text-xs uppercase opacity-60">{m.role}</span>
                                        <span className={
                                            m.role === "you" ? "text-foreground"
                                            : m.role === "error" ? "text-destructive"
                                            : "text-muted-foreground"
                                        }>
                                            {m.role === "you" ? m.text : <Typed text={m.text} />}
                                        </span>
                                    </div>
                                ))}
                                {(planStatus === "planning" || planStatus === "refining") && (
                                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <Spinner /> thinking…
                                    </div>
                                )}
                                <div ref={chatEndRef} />
                            </div>
                        </ScrollArea>
                        <Separator />
                        <div className="flex items-center gap-2 p-3">
                            <Input value={draftMsg} onChange={(e) => setDraftMsg(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                                placeholder={phase === "planning" ? "refine the plan…" : "message a running story…"} />
                            <Button size="icon" onClick={sendMessage} disabled={!draftMsg.trim()} aria-label="Send">
                                <Send className="h-4 w-4" />
                            </Button>
                        </div>
                    </Card>

                    {/* right — DAG + live feed */}
                    <Card className="flex min-h-0 flex-col gap-0 p-0">
                        <div className="flex items-center justify-between border-b px-4 py-2">
                            <span className="text-sm text-muted-foreground">
                                DAG {phase === "planning" ? "· draft (edit via chat)" : "· live"}
                            </span>
                            {phase === "planning" && (
                                <Button size="sm" onClick={() => send({ type: "run_plan" })}>▶ RUN</Button>
                            )}
                        </div>
                        <ScrollArea className="min-h-0 flex-1 p-4">
                            <div className="space-y-3">
                                {levels.map((lvl, li) => (
                                    <div key={li} className="flex items-start gap-3">
                                        <span className="mt-1 w-6 shrink-0 text-xs text-muted-foreground">L{li}</span>
                                        <div className="flex flex-1 flex-wrap gap-2">
                                            {lvl.map((n) => {
                                                const st: StoryStatus = status[n.id] ?? "queued"
                                                const title = stories.find((s) => s.id === n.id)?.title ?? n.id
                                                const isRunning = st === "running"
                                                return (
                                                    <div key={n.id} title={title}
                                                        className={`flex min-w-[8rem] flex-col gap-1 rounded-md border bg-card px-2 py-1.5 text-xs transition-colors ${isRunning ? "border-amber-400/70 shadow-[0_0_0_1px_rgba(251,191,36,0.4)]" : ""}`}>
                                                        <div className="flex items-center gap-1.5">
                                                            {phase !== "planning" && (
                                                                <span className={`h-2 w-2 rounded-full ${isRunning ? "animate-pulse" : ""}`}
                                                                    style={{ background: statusColor(st) }} />
                                                            )}
                                                            <span className="font-medium">{n.id}</span>
                                                            <span style={{ color: tierColor(n.model) }}>{n.model}</span>
                                                        </div>
                                                        <span className="truncate text-muted-foreground/70">{title}</span>
                                                        {isRunning && lastLine[n.id] && (
                                                            <span className="truncate font-mono text-[10px] text-amber-400/80">
                                                                {lastLine[n.id]}
                                                            </span>
                                                        )}
                                                    </div>
                                                )
                                            })}
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
                                    <span className={f.line.startsWith("[tool") ? "text-sky-400/70" : "text-muted-foreground"}>{f.line}</span>
                                </div>
                            ))}
                        </div>
                    </Card>
                </div>
            )}
        </div>
    )
}
