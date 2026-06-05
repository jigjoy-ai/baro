import { useEffect, useState } from "react"

/** Character-by-character reveal — animates an incoming message in on mount. */
export function Typed({ text, speed = 9 }: { text: string; speed?: number }) {
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
    return (
        <span>
            {text.slice(0, n)}
            {n < text.length && <span className="animate-pulse text-baro">▍</span>}
        </span>
    )
}
