/**
 * Collects the terminal `result` event from a `--output-format stream-json`
 * turn while the per-token `stream_event` volume flows past unbuffered. The
 * kept line has the same wrapper shape `--output-format json` produces, so
 * existing `JSON.parse(stdout)` call sites can parse it unchanged.
 */
export class ClaudeStreamResultCollector {
    private pending = ""
    private lastResultLine: string | null = null

    feed(chunk: Buffer): void {
        this.pending += chunk.toString("utf8")
        let newline: number
        while ((newline = this.pending.indexOf("\n")) !== -1) {
            this.consume(this.pending.slice(0, newline))
            this.pending = this.pending.slice(newline + 1)
        }
    }

    /** The raw `result` event line, or null if the stream never produced one. */
    resultLine(): string | null {
        if (this.pending.trim()) {
            this.consume(this.pending)
            this.pending = ""
        }
        return this.lastResultLine
    }

    private consume(raw: string): void {
        const line = raw.trim()
        // Cheap pre-filter: partial-message events are ~all of the volume.
        if (!line || line.startsWith('{"type":"stream_event"')) return
        try {
            const event = JSON.parse(line) as { type?: unknown }
            if (event.type === "result") this.lastResultLine = line
        } catch {
            // Interleaved non-JSON noise (MCP server banners etc.) is not ours.
        }
    }
}
