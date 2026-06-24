import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"

export interface RunOptionsValues {
    plannerModel: string
    llm: string
    effort: string
    tierMap: string
    endpoints: string
    noGit: boolean
}

export function RunOptions({
    v, on,
}: {
    v: RunOptionsValues
    on: <K extends keyof RunOptionsValues>(key: K, value: RunOptionsValues[K]) => void
}) {
    return (
        <div className="space-y-4 rounded-md border bg-muted/20 p-4">
            <div className="grid grid-cols-3 gap-3">
                <Picker label="Planner" value={v.plannerModel} onChange={(x) => on("plannerModel", x)}
                    options={["opus", "sonnet", "haiku"]} />
                <Picker label="Backend" value={v.llm} onChange={(x) => on("llm", x)}
                    options={["claude", "openai", "codex", "opencode", "pi"]} />
                <Picker label="Effort" value={v.effort} onChange={(x) => on("effort", x)}
                    options={["low", "medium", "high", "xhigh", "max"]} />
            </div>
            <div className="space-y-1.5">
                <Label>Tier map <span className="text-muted-foreground">(optional)</span></Label>
                <Input value={v.tierMap} onChange={(e) => on("tierMap", e.target.value)}
                    placeholder="haiku=openai:MiniMax-M3@minimax,opus=claude:opus"
                    className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
                <Label>OpenAI endpoints <span className="text-muted-foreground">(name=url, one per line)</span></Label>
                <Textarea rows={2} value={v.endpoints} onChange={(e) => on("endpoints", e.target.value)}
                    placeholder="minimax=https://api.minimax.io/v1" className="font-mono text-xs" />
                <p className="text-xs text-muted-foreground">
                    Keys come from <code>BARO_OPENAI_KEY_&lt;NAME&gt;</code> / <code>OPENAI_API_KEY</code> in the env.
                </p>
            </div>
            <div className="flex items-center gap-2">
                <Switch id="nogit" checked={v.noGit} onCheckedChange={(x) => on("noGit", x)} />
                <Label htmlFor="nogit">No git (skip branch / PR)</Label>
            </div>
        </div>
    )
}

function Picker({ label, value, onChange, options }: {
    label: string; value: string; onChange: (v: string) => void; options: string[]
}) {
    return (
        <div className="space-y-1.5">
            <Label>{label}</Label>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                    {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
            </Select>
        </div>
    )
}
