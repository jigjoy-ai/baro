import { useEffect, useRef, useState } from "react"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Send } from "lucide-react"
import type { ChatMsg, PlanStatus } from "@/protocol"
import { Typed } from "./Typed"
import { Spinner } from "./Spinner"

export function ChatPanel({
    chat, planStatus, placeholder, onSend,
}: {
    chat: ChatMsg[]
    planStatus: PlanStatus
    placeholder: string
    onSend: (text: string) => void
}) {
    const [draft, setDraft] = useState("")
    const endRef = useRef<HTMLDivElement>(null)
    const thinking = planStatus === "planning" || planStatus === "refining"

    useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }) }, [chat, thinking])

    function submit() {
        const t = draft.trim()
        if (!t) return
        onSend(t)
        setDraft("")
    }

    return (
        <Card className="flex h-full min-h-0 flex-col p-0">
            <ScrollArea className="min-h-0 flex-1 p-4">
                <div className="flex flex-col gap-4">
                    {chat.map((m, i) => <Bubble key={i} m={m} />)}
                    {thinking && (
                        <div className="flex items-center gap-2">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-baro" />
                            <span className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner /> thinking…
                            </span>
                        </div>
                    )}
                    <div ref={endRef} />
                </div>
            </ScrollArea>
            <Separator />
            <div className="flex items-center gap-2 p-3">
                <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder={placeholder}
                />
                <Button size="icon" onClick={submit} disabled={!draft.trim()} aria-label="Send">
                    <Send className="h-4 w-4" />
                </Button>
            </div>
        </Card>
    )
}

function Bubble({ m }: { m: ChatMsg }) {
    if (m.role === "you") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-br-sm bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                    {m.text}
                </div>
            </div>
        )
    }
    const error = m.role === "error"
    return (
        <div className="flex gap-2">
            <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-[2px] ${error ? "bg-destructive" : "bg-baro"}`} />
            <div className={[
                "max-w-[85%] rounded-lg rounded-tl-sm px-3 py-2 text-sm leading-relaxed",
                error ? "bg-destructive/10 text-destructive" : "bg-muted/40 text-foreground/90",
            ].join(" ")}>
                {error ? m.text : <Typed text={m.text} />}
            </div>
        </div>
    )
}
