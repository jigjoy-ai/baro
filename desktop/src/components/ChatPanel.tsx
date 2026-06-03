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
                    {thinking && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner /> thinking…
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
