import { createServer } from "node:http"

const notes = []
let nextId = 1

function sendJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
}

async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks).toString("utf8")
}

export const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/notes") {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify(notes))
    }
    if (req.method === "POST" && req.url === "/notes") {
        let body
        try {
            body = JSON.parse(await readBody(req))
        } catch {
            return sendJson(res, 400, { error: "Invalid JSON body" })
        }
        if (body === null || typeof body !== "object" || Array.isArray(body) || typeof body.text !== "string" || body.text.trim() === "") {
            return sendJson(res, 400, { error: "Field 'text' must be a non-empty string" })
        }
        const note = { id: String(nextId++), text: body.text }
        notes.push(note)
        return sendJson(res, 201, note)
    }
    const match = req.method === "DELETE" && req.url.match(/^\/notes\/([^/?]+)$/)
    if (match) {
        let id
        try {
            id = decodeURIComponent(match[1])
        } catch {
            return sendJson(res, 404, { error: "Note not found" })
        }
        const index = notes.findIndex(n => n.id === id)
        if (index === -1) return sendJson(res, 404, { error: "Note not found" })
        notes.splice(index, 1)
        return res.writeHead(204).end()
    }
    res.writeHead(404).end()
})

if (import.meta.url === `file://${process.argv[1]}`) server.listen(3000)
