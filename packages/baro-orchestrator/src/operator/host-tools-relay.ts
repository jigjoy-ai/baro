import { randomBytes, timingSafeEqual } from "node:crypto"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { StringDecoder } from "node:string_decoder"

import type { HostFunction } from "../harness/lane-adapter.js"

/* Host functions reachable from a Claude CLI living in another process: a
   loopback JSON-lines relay in this process, and a stdio MCP server (this same
   bundle in `__operator-mcp` mode) that the CLI spawns and that forwards every
   tools/call here. General where the planner's relay was single-purpose. */

export const OPERATOR_MCP_MODE = "__operator-mcp"
export const OPERATOR_MCP_SERVER_NAME = "baro"
const RELAY_TOKEN_ENV = "BARO_OPERATOR_RELAY_TOKEN"
const LOOPBACK_HOST = "127.0.0.1"
const RELAY_TIMEOUT_MS = 10 * 60_000
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const MCP_PROTOCOL_VERSION = "2025-06-18"

export interface RelayConnection {
    readonly command: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
}

export class HostToolsRelay {
    private readonly token = randomBytes(32).toString("hex")
    private readonly sockets = new Set<Socket>()
    private server: Server | null = null

    constructor(
        private readonly functions: readonly HostFunction[],
        private readonly instructions: string,
    ) {}

    async open(): Promise<RelayConnection> {
        const server = createServer((socket) => this.handleSocket(socket))
        this.server = server
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(0, LOOPBACK_HOST, () => resolve())
        })
        const address = server.address()
        if (!address || typeof address === "string") {
            throw new Error("operator relay did not receive a TCP port")
        }
        const entry = process.argv[1]
        if (!entry) throw new Error("operator relay requires a script entry path")
        return {
            command: process.execPath,
            args: [
                ...process.execArgv,
                entry,
                OPERATOR_MCP_MODE,
                "--bridge-host",
                LOOPBACK_HOST,
                "--bridge-port",
                String(address.port),
            ],
            env: { [RELAY_TOKEN_ENV]: this.token },
        }
    }

    async close(): Promise<void> {
        const server = this.server
        this.server = null
        if (!server) return
        await new Promise<void>((resolve) => {
            server.close(() => resolve())
            for (const socket of this.sockets) socket.destroy()
        })
    }

    private handleSocket(socket: Socket): void {
        this.sockets.add(socket)
        socket.setEncoding("utf8")
        socket.setTimeout(RELAY_TIMEOUT_MS, () => socket.destroy())
        let buffer = ""
        let handled = false
        socket.on("data", (chunk: string) => {
            if (handled) return
            buffer += chunk
            if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
                handled = true
                reply(socket, { ok: false, error: "relay message exceeded the size limit" })
                return
            }
            const newline = buffer.indexOf("\n")
            if (newline < 0) return
            handled = true
            void this.dispatch(buffer.slice(0, newline))
                .then((result) => reply(socket, { ok: true, result }))
                .catch((error) => reply(socket, { ok: false, error: messageOf(error) }))
        })
        socket.on("error", () => undefined)
        socket.on("close", () => this.sockets.delete(socket))
    }

    private async dispatch(line: string): Promise<unknown> {
        let request: unknown
        try {
            request = JSON.parse(line)
        } catch {
            throw new Error("relay request is not valid JSON")
        }
        if (!isRecord(request) || !safeToken(request.token, this.token)) {
            throw new Error("relay authentication failed")
        }
        if (request.type === "describe") {
            return {
                instructions: this.instructions,
                tools: this.functions.map((fn) => ({
                    name: fn.name,
                    description: fn.description,
                    inputSchema: fn.parameters,
                })),
            }
        }
        if (request.type === "call") {
            const fn = this.functions.find((candidate) => candidate.name === request.name)
            if (!fn) throw new Error(`unknown tool: ${String(request.name)}`)
            return await fn.invoke(request.args)
        }
        throw new Error("relay request has an unknown type")
    }
}

interface McpInvocation {
    readonly host: string
    readonly port: number
    readonly token: string
}

export function parseOperatorMcpInvocation(
    argv: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): McpInvocation | null {
    if (argv[0] !== OPERATOR_MCP_MODE) return null
    let host: string | undefined
    let port: number | undefined
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index]
        const value = argv[index + 1]
        if (flag === "--bridge-host") host = value
        else if (flag === "--bridge-port") port = Number(value)
        else throw new Error(`unknown operator MCP flag: ${flag}`)
    }
    const token = environment[RELAY_TOKEN_ENV]
    if (host !== LOOPBACK_HOST) throw new Error("operator MCP bridge must use IPv4 loopback")
    if (!Number.isInteger(port) || port! < 1 || port! > 65_535) {
        throw new Error("operator MCP bridge port is invalid")
    }
    if (!token || !/^[a-f0-9]{64}$/u.test(token)) {
        throw new Error("operator MCP bridge token is invalid")
    }
    return { host, port: port!, token }
}

/** The stdio side the CLI spawns: newline-delimited JSON-RPC, forwarded to the relay. */
export async function runOperatorMcpServer(connection: McpInvocation): Promise<void> {
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    for await (const chunk of process.stdin) {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
        let newline: number
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line) await handleLine(line, connection)
        }
    }
}

async function handleLine(line: string, connection: McpInvocation): Promise<void> {
    let request: unknown
    try {
        request = JSON.parse(line)
    } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        return
    }
    if (!isRecord(request) || request.jsonrpc !== "2.0") return
    const id = request.id
    const method = typeof request.method === "string" ? request.method : ""
    if (id === undefined || !method) return
    try {
        switch (method) {
            case "initialize": {
                const described = (await callRelay(connection, { type: "describe" })) as {
                    instructions: string
                }
                write({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: "baro-operator", version: "1.0.0" },
                        instructions: described.instructions,
                    },
                })
                return
            }
            case "ping":
                write({ jsonrpc: "2.0", id, result: {} })
                return
            case "tools/list": {
                const described = (await callRelay(connection, { type: "describe" })) as {
                    tools: unknown[]
                }
                write({ jsonrpc: "2.0", id, result: { tools: described.tools } })
                return
            }
            case "tools/call": {
                const params = isRecord(request.params) ? request.params : {}
                try {
                    const result = await callRelay(connection, {
                        type: "call",
                        name: params.name,
                        args: params.arguments,
                    })
                    const text = typeof result === "string" ? result : JSON.stringify(result)
                    write({
                        jsonrpc: "2.0",
                        id,
                        result: { content: [{ type: "text", text }], isError: false },
                    })
                } catch (error) {
                    write({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: `Error: ${messageOf(error)}` }],
                            isError: true,
                        },
                    })
                }
                return
            }
            default:
                write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
        }
    } catch (error) {
        write({ jsonrpc: "2.0", id, error: { code: -32000, message: messageOf(error) } })
    }
}

async function callRelay(connection: McpInvocation, request: Record<string, unknown>): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
        const socket = createConnection({ host: connection.host, port: connection.port })
        socket.setEncoding("utf8")
        socket.setTimeout(RELAY_TIMEOUT_MS, () => socket.destroy(new Error("operator relay timed out")))
        let buffer = ""
        socket.once("connect", () => {
            socket.write(JSON.stringify({ ...request, token: connection.token }) + "\n")
        })
        socket.on("data", (chunk: string) => {
            buffer += chunk
            const newline = buffer.indexOf("\n")
            if (newline < 0) return
            socket.destroy()
            let response: unknown
            try {
                response = JSON.parse(buffer.slice(0, newline))
            } catch {
                reject(new Error("operator relay returned invalid JSON"))
                return
            }
            if (!isRecord(response) || typeof response.ok !== "boolean") {
                reject(new Error("operator relay returned an invalid response"))
                return
            }
            if (!response.ok) {
                reject(new Error(messageOf(response.error)))
                return
            }
            resolve(response.result)
        })
        socket.once("error", reject)
        socket.once("close", () => {
            if (!buffer.includes("\n")) reject(new Error("operator relay closed without a response"))
        })
    })
}

function write(message: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(message) + "\n")
}

function reply(socket: Socket, response: Record<string, unknown>): void {
    if (socket.destroyed) return
    socket.end(JSON.stringify(response) + "\n")
}

function safeToken(actual: unknown, expected: string): boolean {
    if (typeof actual !== "string") return false
    const left = Buffer.from(actual)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageOf(value: unknown): string {
    if (value instanceof Error) return value.message
    if (typeof value === "string" && value.trim()) return value
    return String(value)
}
