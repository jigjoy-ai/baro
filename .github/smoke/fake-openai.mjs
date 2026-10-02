// Stand-in OpenAI endpoint for the Windows smoke run: answers each phase with
// the minimal valid reply from reply.mjs, so no model and no key is involved.
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"
import { phaseOf, replyFor } from "./reply.mjs"

const log = process.argv[2]
createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
        let body = {}
        try { body = JSON.parse(raw || "{}") } catch {}
        appendFileSync(log, `${new Date().toISOString()} ${req.method} ${req.url} model=${body.model} stream=${!!body.stream} tools=${(body.tools ?? []).length}\n`)
        const strings = []
        const walk = (v) => {
            if (typeof v === "string") strings.push(v)
            else if (Array.isArray(v)) v.forEach(walk)
            else if (v && typeof v === "object") Object.values(v).forEach(walk)
        }
        walk(body.input ?? body.messages ?? [])
        const prompt = strings.filter((s) => s.length > 40).join("\n")
        const text = replyFor(prompt)
        appendFileSync(log, `  phase=${phaseOf(prompt)} head=${JSON.stringify(prompt.trimStart().slice(0, 90))} -> ${text.slice(0, 60)}\n`)
        if (req.url.endsWith("/responses")) {
            res.setHeader("content-type", "application/json")
            res.end(JSON.stringify({
                id: "resp_1", object: "response", status: "completed", model: body.model,
                output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
                usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
            }))
            return
        }
        if (body.stream) {
            res.setHeader("content-type", "text/event-stream")
            res.write(`data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text } }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ id: "c1", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
            res.end("data: [DONE]\n\n")
            return
        }
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    })
}).listen(8787, "127.0.0.1")
