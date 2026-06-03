import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type {
    ChatMsg,
    DoneInfo,
    DraftStory,
    Phase,
    PlanStatus,
    RunConfig,
    SessionEvent,
    StoryStatus,
    Tokens,
} from "@/protocol"

/**
 * Owns the whole runtime: subscribes to the session event stream from the
 * Tauri core, reduces it into render state, and exposes the actions the UI
 * needs (start / steer / run). Keeping this out of the view components lets
 * them stay presentational.
 */
export function useSession() {
    const [phase, setPhase] = useState<Phase>("idle")
    const [planStatus, setPlanStatus] = useState<PlanStatus>("idle")
    const [plannerModel, setPlannerModel] = useState("sonnet")
    const [backend, setBackend] = useState("claude")
    const [stories, setStories] = useState<DraftStory[]>([])
    const [levels, setLevels] = useState<{ id: string; model: string }[][]>([])
    const [status, setStatus] = useState<Record<string, StoryStatus>>({})
    const [lastLine, setLastLine] = useState<Record<string, string>>({})
    const [chat, setChat] = useState<ChatMsg[]>([])
    const [feed, setFeed] = useState<{ id: string; line: string }[]>([])
    const [tokens, setTokens] = useState<Tokens>({ input: 0, output: 0 })
    const [prUrl, setPrUrl] = useState<string | null>(null)
    const [target, setTarget] = useState<string | null>(null)
    const [doneInfo, setDoneInfo] = useState<DoneInfo | null>(null)
    const [elapsedSecs, setElapsedSecs] = useState(0)

    const startedAt = useRef<number | null>(null)
    // Mirror the bits the done-summary needs without re-subscribing.
    const storiesRef = useRef<DraftStory[]>([])
    const statusRef = useRef<Record<string, StoryStatus>>({})
    storiesRef.current = stories
    statusRef.current = status

    useEffect(() => {
        const subs = Promise.all([
            listen<string>("session-event", (e) => onEvent(e.payload)),
            listen<string>("session-log", (e) =>
                setFeed((f) => [...f.slice(-400), { id: "·", line: e.payload }]),
            ),
        ])
        return () => void subs.then((fns) => fns.forEach((f) => f()))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Live elapsed timer while the run is active.
    useEffect(() => {
        if (phase !== "planning" && phase !== "executing") return
        const id = setInterval(() => {
            if (startedAt.current) setElapsedSecs(Math.round((Date.now() - startedAt.current) / 1000))
        }, 1000)
        return () => clearInterval(id)
    }, [phase])

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
            case "token_usage":
                setTokens((t) => ({
                    input: t.input + (evt.input_tokens || 0),
                    output: t.output + (evt.output_tokens || 0),
                }))
                break
            case "finalize_complete":
                setPrUrl(evt.pr_url)
                break
            case "done": {
                const st = statusRef.current
                const all = storiesRef.current
                setPhase("done")
                setDoneInfo({
                    success: evt.success,
                    totalSecs: evt.total_time_secs,
                    done: all.filter((s) => st[s.id] === "done").length,
                    total: all.length,
                    prUrl: null, // filled from prUrl state in the view
                })
                break
            }
        }
    }

    const start = useCallback(async (cfg: RunConfig) => {
        setChat([{ role: "you", text: cfg.goal }])
        setBackend(cfg.llm)
        startedAt.current = Date.now()
        setElapsedSecs(0)
        try {
            await invoke("start_session", { args: cfg })
            setPhase("planning")
        } catch (e) {
            setChat((c) => [...c, { role: "error", text: String(e) }])
        }
    }, [])

    const send = useCallback(async (line: object) => {
        await invoke("send_command", { line: JSON.stringify(line) })
    }, [])

    const run = useCallback(() => void send({ type: "run_plan" }), [send])

    const sendMessage = useCallback(async (text: string, phaseNow: Phase) => {
        const t = text.trim()
        if (!t) return
        if (phaseNow === "planning") {
            setChat((c) => [...c, { role: "you", text: t }])
            await send({ type: "plan_message", text: t })
            return
        }
        const running = storiesRef.current.filter((s) => statusRef.current[s.id] === "running").map((s) => s.id)
        const to = target ?? running[0]
        if (!to) return
        setChat((c) => [...c, { role: "you", text: `→ ${to}: ${t}` }])
        await send({ type: "redirect", story_id: to, text: t })
    }, [send, target])

    return {
        phase, planStatus, plannerModel, backend,
        stories, levels, status, lastLine, chat, feed,
        tokens, prUrl, target, doneInfo, elapsedSecs,
        setTarget, start, sendMessage, run,
    }
}

export type SessionState = ReturnType<typeof useSession>
