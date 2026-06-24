import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import type { RunConfig } from "@/protocol"
import { RunOptions, type RunOptionsValues } from "./RunOptions"

const BACKENDS = [
    {
        id: "claude",
        name: "Claude Code",
        desc: "The default. Drives every phase through your existing Claude Code CLI.",
    },
    {
        id: "openai",
        name: "OpenAI (native)",
        desc: "Runs every phase through gpt-5.x via baro's native OpenAI inference runner. Requires OPENAI_API_KEY in your shell.",
    },
    {
        id: "codex",
        name: "Codex CLI",
        desc: "Drives phases through OpenAI's Codex CLI — a subscription-priced backend that arbitrages your Codex plan instead of per-token API billing.",
    },
    {
        id: "opencode",
        name: "OpenCode",
        desc: "Drives phases through the OpenCode CLI agent (opencode run). Available when the opencode binary is on your PATH.",
    },
    {
        id: "pi",
        name: "Pi",
        desc: "Drives phases through the Pi coding-agent CLI (pi -p, one-shot JSON). Available when the pi binary is on your PATH.",
    },
] as const

export function StartView({ onStart }: { onStart: (cfg: RunConfig) => void }) {
    const [goal, setGoal] = useState("")
    const [cwd, setCwd] = useState("")
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [opts, setOpts] = useState<RunOptionsValues>({
        plannerModel: "sonnet",
        llm: "claude",
        effort: "high",
        tierMap: "",
        endpoints: "",
        noGit: false,
    })
    const set = <K extends keyof RunOptionsValues>(k: K, val: RunOptionsValues[K]) =>
        setOpts((o) => ({ ...o, [k]: val }))

    const ready = goal.trim().length > 0 && cwd.trim().length > 0

    function cycleBackend(dir: 1 | -1) {
        const i = BACKENDS.findIndex((b) => b.id === opts.llm)
        const next = BACKENDS[(i + dir + BACKENDS.length) % BACKENDS.length]
        set("llm", next.id)
    }

    function submit() {
        if (!ready) return
        onStart({
            goal: goal.trim(),
            cwd: cwd.trim(),
            planner_model: opts.plannerModel,
            llm: opts.llm,
            effort: opts.effort,
            no_git: opts.noGit,
            tier_map: opts.tierMap.trim() || null,
            openai_endpoints: opts.endpoints.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
        })
    }

    return (
        <div className="flex flex-1 items-center justify-center overflow-auto p-6">
            <Card className="w-full max-w-2xl space-y-4 p-6">
                <div>
                    <h2 className="text-lg font-semibold">Start a run</h2>
                    <p className="text-sm text-muted-foreground">Describe a goal, point it at a repo, and walk away.</p>
                </div>
                <div className="space-y-1.5">
                    <Label>Goal</Label>
                    <Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)}
                        placeholder="Add a reservations module to the service…" />
                </div>
                <div className="space-y-1.5">
                    <Label>Working directory</Label>
                    <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/target/repo" />
                </div>

                {/* backend picker — keyboard navigable, like the TUI */}
                <div className="space-y-1.5">
                    <Label>Pick a backend</Label>
                    <div
                        tabIndex={0}
                        onKeyDown={(e) => {
                            if (e.key === "ArrowDown") { e.preventDefault(); cycleBackend(1) }
                            else if (e.key === "ArrowUp") { e.preventDefault(); cycleBackend(-1) }
                            else if (e.key === "Enter") { e.preventDefault(); submit() }
                        }}
                        className="space-y-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-baro/40"
                    >
                        {BACKENDS.map((b) => {
                            const active = opts.llm === b.id
                            return (
                                <button
                                    type="button"
                                    key={b.id}
                                    onClick={() => set("llm", b.id)}
                                    className={[
                                        "flex w-full items-start gap-2 rounded-md border px-3 py-2.5 text-left transition-colors",
                                        active ? "border-baro/70 bg-baro-soft" : "border-border hover:border-foreground/30",
                                    ].join(" ")}
                                >
                                    <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-baro" : "text-transparent"}`} />
                                    <span className="min-w-0">
                                        <span className={`block text-sm font-medium ${active ? "text-baro" : "text-foreground"}`}>{b.name}</span>
                                        <span className="block text-xs leading-relaxed text-muted-foreground">{b.desc}</span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70">
                        <span className="text-muted-foreground">↑/↓</span> choose · <span className="text-muted-foreground">Enter</span> confirm
                    </p>
                </div>

                <button type="button" onClick={() => setShowAdvanced((s) => !s)}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                    {showAdvanced ? "▾" : "▸"} Run options
                </button>
                {showAdvanced && <RunOptions v={opts} on={set} />}

                <Button onClick={submit} disabled={!ready}
                    className="w-full bg-baro text-black hover:bg-baro/90">
                    Plan it ▸
                </Button>
            </Card>
        </div>
    )
}
