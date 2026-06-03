import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import type { RunConfig } from "@/protocol"
import { RunOptions, type RunOptionsValues } from "./RunOptions"

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
