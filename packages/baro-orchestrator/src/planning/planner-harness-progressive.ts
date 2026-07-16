/**
 * Run-scoped MCP transport for subscription-backed planner harnesses.
 *
 * Claude Code and Codex spawn the same tiny stdio MCP server. The server has
 * no repository authority of its own: each tool call is correlated over a
 * token-protected loopback socket to this planner process, validated by the
 * shared progressive-plan state machine, and only then published upstream.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
import {
    createConnection,
    createServer,
    type Server,
    type Socket,
} from "node:net"
import { StringDecoder } from "node:string_decoder"

import {
    createPlannerProgressivePublisher,
    PUBLISH_PLAN_FRAGMENT_DESCRIPTION,
    PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
    PROGRESSIVE_PLANNING_INSTRUCTION,
    type PlannerOpenAIProgressiveConfig,
    type PlannerProgressivePublisher,
} from "./planner-openai-progressive.js"

export const PROGRESSIVE_PLANNER_MCP_MODE =
    "--serve-progressive-planner-mcp"
export const PROGRESSIVE_PLANNER_MCP_SERVER_NAME = "baro_planning"
export const PROGRESSIVE_PLANNER_MCP_TOOL_NAME = "publish_plan_fragment"
export const PROGRESSIVE_PLANNER_RELAY_TOKEN_ENV =
    "BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN"

const LOOPBACK_HOST = "127.0.0.1"
const MAX_RELAY_MESSAGE_BYTES = 8 * 1024 * 1024
const RELAY_TIMEOUT_MS = 60_000
const MCP_PROTOCOL_VERSION = "2024-11-05"

export interface PlannerMcpServerCommand {
    command: string
    /** Base args; the relay connection flags are appended per run. */
    args: readonly string[]
}

export interface PlannerHarnessProgressiveConfig
    extends PlannerOpenAIProgressiveConfig {
    mcpServer: PlannerMcpServerCommand
}

export interface PlannerHarnessMcpConnection {
    command: string
    args: string[]
    /** Secret-bearing variables for the provider process. The provider's MCP
     * config references these names; their values must never be serialized. */
    providerEnvironment: Record<string, string>
}

export interface PlannerHarnessProgressiveSupport {
    readonly systemInstruction: string | null
    readonly mcpConnection: PlannerHarnessMcpConnection | null
    reconcileFinalCandidate(candidate: string): void
    assertInitialized(): void
    hasEarlyPlan(): boolean
    close(): Promise<void>
}

const NO_HARNESS_PROGRESSIVE_SUPPORT: PlannerHarnessProgressiveSupport =
    Object.freeze({
        systemInstruction: null,
        mcpConnection: null,
        reconcileFinalCandidate: (_candidate: string) => undefined,
        assertInitialized: () => undefined,
        hasEarlyPlan: () => false,
        close: async () => undefined,
    })

/** Open the parent side of one progressive planner MCP session. */
export async function createPlannerHarnessProgressiveSupport(
    config: PlannerHarnessProgressiveConfig | undefined,
): Promise<PlannerHarnessProgressiveSupport> {
    if (!config) return NO_HARNESS_PROGRESSIVE_SUPPORT
    validateMcpServerCommand(config.mcpServer)
    const publisher = createPlannerProgressivePublisher(config)
    const relay = new ProgressivePlannerRelay(publisher)
    const connection = await relay.open(config.mcpServer)
    return {
        systemInstruction: PROGRESSIVE_PLANNING_INSTRUCTION,
        mcpConnection: connection,
        reconcileFinalCandidate: (candidate) =>
            publisher.reconcileFinalCandidate(candidate),
        assertInitialized: () => relay.assertInitialized(),
        hasEarlyPlan: () => publisher.hasEarlyPlan(),
        close: () => relay.close(),
    }
}

/**
 * Point a harness-spawned MCP child back at the current run-planner entry.
 * This works both for the shipped single-file .mjs bundle and for a TSX dev
 * checkout because Node's active loader flags are inherited explicitly.
 */
export function currentPlannerMcpServerCommand(): PlannerMcpServerCommand {
    const entry = process.argv[1]
    if (typeof entry !== "string" || !entry.trim()) {
        throw new Error("progressive planner MCP requires a script entry path")
    }
    return {
        command: process.execPath,
        args: [...process.execArgv, entry, PROGRESSIVE_PLANNER_MCP_MODE],
    }
}

class ProgressivePlannerRelay {
    private readonly token = randomBytes(32).toString("hex")
    private readonly sockets = new Set<Socket>()
    private server: Server | null = null
    private initialized = false
    private closed = false
    private closeTask: Promise<void> | null = null
    private operationTail: Promise<void> = Promise.resolve()

    constructor(private readonly publisher: PlannerProgressivePublisher) {}

    async open(
        command: PlannerMcpServerCommand,
    ): Promise<PlannerHarnessMcpConnection> {
        if (this.server) throw new Error("progressive planner relay is already open")
        const server = createServer((socket) => this.handleSocket(socket))
        this.server = server
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                server.off("listening", onListening)
                reject(error)
            }
            const onListening = (): void => {
                server.off("error", onError)
                resolve()
            }
            server.once("error", onError)
            server.once("listening", onListening)
            server.listen(0, LOOPBACK_HOST)
        })
        const address = server.address()
        if (!address || typeof address === "string") {
            await this.close()
            throw new Error("progressive planner relay did not receive a TCP port")
        }
        return {
            command: command.command,
            args: [
                ...command.args,
                "--bridge-host",
                LOOPBACK_HOST,
                "--bridge-port",
                String(address.port),
            ],
            // Keep the bearer separate from the server's positional args.
            // MCP clients scope this environment map to the stdio child.
            providerEnvironment: {
                [PROGRESSIVE_PLANNER_RELAY_TOKEN_ENV]: this.token,
            },
        }
    }

    assertInitialized(): void {
        if (!this.initialized) {
            throw new Error(
                "progressive planner MCP server was not initialized by the harness",
            )
        }
    }

    close(): Promise<void> {
        this.closeTask ??= this.closeOnce()
        return this.closeTask
    }

    private async closeOnce(): Promise<void> {
        if (this.closed) return
        this.closed = true
        const server = this.server
        this.server = null
        if (server) {
            await new Promise<void>((resolve) => {
                server.close(() => resolve())
                for (const socket of this.sockets) socket.destroy()
            })
        }
        // A provider can exit while its last tool receipt is still crossing
        // stdio. Do not report cleanup complete until the corresponding
        // upstream publication has settled.
        await this.operationTail
    }

    private handleSocket(socket: Socket): void {
        if (this.closed) {
            socket.destroy()
            return
        }
        this.sockets.add(socket)
        socket.setEncoding("utf8")
        socket.setTimeout(RELAY_TIMEOUT_MS, () => socket.destroy())
        let buffer = ""
        let handled = false
        socket.on("data", (chunk: string) => {
            if (handled) return
            buffer += chunk
            if (Buffer.byteLength(buffer, "utf8") > MAX_RELAY_MESSAGE_BYTES) {
                handled = true
                this.reply(socket, {
                    ok: false,
                    error: "progressive planner relay message exceeded the size limit",
                })
                return
            }
            const newline = buffer.indexOf("\n")
            if (newline < 0) return
            handled = true
            const line = buffer.slice(0, newline)
            void this.dispatchLine(line)
                .then((result) => this.reply(socket, { ok: true, result }))
                .catch((error) =>
                    this.reply(socket, {
                        ok: false,
                        error: messageOf(error),
                    }),
                )
        })
        socket.on("error", () => undefined)
        socket.on("close", () => this.sockets.delete(socket))
    }

    private async dispatchLine(line: string): Promise<unknown> {
        let request: unknown
        try {
            request = JSON.parse(line)
        } catch {
            throw new Error("progressive planner relay request is not valid JSON")
        }
        if (!isPlainRecord(request) || !safeToken(request.token, this.token)) {
            throw new Error("progressive planner relay authentication failed")
        }
        const operation = this.operationTail.then(
            () => this.dispatchAuthenticated(request),
            () => this.dispatchAuthenticated(request),
        )
        this.operationTail = operation.then(
            () => undefined,
            () => undefined,
        )
        return await operation
    }

    private async dispatchAuthenticated(
        request: Record<string, unknown>,
    ): Promise<unknown> {
        if (request.type === "initialize") {
            this.initialized = true
            return { initialized: true }
        }
        if (request.type === "publish") {
            if (!this.initialized) {
                throw new Error(
                    "progressive planner MCP must initialize before publishing",
                )
            }
            return await this.publisher.publish(request.args)
        }
        throw new Error("progressive planner relay request has an unknown type")
    }

    private reply(socket: Socket, response: Record<string, unknown>): void {
        if (socket.destroyed) return
        socket.end(JSON.stringify(response) + "\n")
    }
}

function validateMcpServerCommand(command: PlannerMcpServerCommand): void {
    if (!safeText(command?.command)) {
        throw new Error("progressive planner MCP command must be safe non-empty text")
    }
    if (!Array.isArray(command.args) || command.args.some((arg) => !safeText(arg))) {
        throw new Error("progressive planner MCP args must be safe non-empty text")
    }
}

function safeToken(actual: unknown, expected: string): boolean {
    if (typeof actual !== "string") return false
    const left = Buffer.from(actual)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}

function safeText(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 64 * 1024 &&
        !/[\u0000\r\n]/u.test(value)
    )
}

interface ProgressiveMcpInvocation {
    bridgeHost: typeof LOOPBACK_HOST
    bridgePort: number
    bridgeToken: string
}

/** Parse only the private alternate-mode flags accepted by the MCP child. */
export function parseProgressivePlannerMcpInvocation(
    argv: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): ProgressiveMcpInvocation | null {
    if (argv[0] !== PROGRESSIVE_PLANNER_MCP_MODE) return null
    let bridgeHost: string | undefined
    let bridgePort: string | undefined
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index]
        const value = argv[index + 1]
        if (value === undefined) {
            throw new Error(`progressive planner MCP flag ${flag} requires a value`)
        }
        switch (flag) {
            case "--bridge-host":
                bridgeHost = value
                break
            case "--bridge-port":
                bridgePort = value
                break
            default:
                throw new Error(`unknown progressive planner MCP flag: ${flag}`)
        }
    }
    const port = Number(bridgePort)
    if (bridgeHost !== LOOPBACK_HOST) {
        throw new Error("progressive planner MCP bridge must use IPv4 loopback")
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("progressive planner MCP bridge port is invalid")
    }
    const bridgeToken = environment[PROGRESSIVE_PLANNER_RELAY_TOKEN_ENV]
    if (!bridgeToken || !/^[a-f0-9]{64}$/u.test(bridgeToken)) {
        throw new Error("progressive planner MCP bridge token is invalid")
    }
    return {
        bridgeHost,
        bridgePort: port,
        bridgeToken,
    }
}

interface McpStdioOptions extends ProgressiveMcpInvocation {
    input?: NodeJS.ReadableStream & AsyncIterable<Buffer | string>
    output?: NodeJS.WritableStream
}

/** Serve the single Baro planning tool over newline-delimited MCP stdio. */
export async function runProgressivePlannerMcpServer(
    options: McpStdioOptions,
): Promise<void> {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    for await (const chunk of input) {
        if (typeof chunk === "string") {
            buffer += decoder.end()
            buffer += chunk
        } else {
            buffer += decoder.write(chunk)
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_RELAY_MESSAGE_BYTES) {
            writeJsonRpc(output, jsonRpcError(null, -32600, "MCP request exceeded size limit"))
            throw new Error("progressive planner MCP input exceeded size limit")
        }
        let newline: number
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) continue
            await handleMcpLine(line, options, output)
        }
    }
    buffer += decoder.end()
    if (buffer.trim()) await handleMcpLine(buffer.trim(), options, output)
}

async function handleMcpLine(
    line: string,
    connection: ProgressiveMcpInvocation,
    output: NodeJS.WritableStream,
): Promise<void> {
    let request: unknown
    try {
        request = JSON.parse(line)
    } catch {
        writeJsonRpc(output, jsonRpcError(null, -32700, "Parse error"))
        return
    }
    if (!isPlainRecord(request) || request.jsonrpc !== "2.0") {
        writeJsonRpc(output, jsonRpcError(requestId(request), -32600, "Invalid Request"))
        return
    }
    const id = requestId(request)
    const method = typeof request.method === "string" ? request.method : ""
    if (!method) {
        if (id !== undefined) {
            writeJsonRpc(output, jsonRpcError(id, -32600, "Invalid Request"))
        }
        return
    }
    // Notifications deliberately have no response.
    if (id === undefined) return
    try {
        switch (method) {
            case "initialize": {
                await callRelay(connection, { type: "initialize" })
                writeJsonRpc(
                    output,
                    jsonRpcResult(id, {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: {
                            name: "baro-progressive-planner",
                            version: "1.0.0",
                        },
                        instructions: PROGRESSIVE_PLANNING_INSTRUCTION,
                    }),
                )
                return
            }
            case "ping":
                writeJsonRpc(output, jsonRpcResult(id, {}))
                return
            case "tools/list":
                writeJsonRpc(
                    output,
                    jsonRpcResult(id, {
                        tools: [
                            {
                                name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                                title: "Publish plan fragment",
                                description: PUBLISH_PLAN_FRAGMENT_DESCRIPTION,
                                inputSchema: PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
                                annotations: {
                                    readOnlyHint: false,
                                    destructiveHint: false,
                                    idempotentHint: false,
                                    openWorldHint: false,
                                },
                            },
                        ],
                    }),
                )
                return
            case "tools/call": {
                const params = isPlainRecord(request.params) ? request.params : {}
                if (params.name !== PROGRESSIVE_PLANNER_MCP_TOOL_NAME) {
                    writeJsonRpc(
                        output,
                        jsonRpcResult(id, toolError(`unknown tool: ${String(params.name)}`)),
                    )
                    return
                }
                try {
                    const result = await callRelay(connection, {
                        type: "publish",
                        args: params.arguments,
                    })
                    writeJsonRpc(output, jsonRpcResult(id, toolSuccess(result)))
                } catch (error) {
                    writeJsonRpc(output, jsonRpcResult(id, toolError(messageOf(error))))
                }
                return
            }
            default:
                writeJsonRpc(output, jsonRpcError(id, -32601, "Method not found"))
        }
    } catch (error) {
        writeJsonRpc(output, jsonRpcError(id, -32000, messageOf(error)))
    }
}

async function callRelay(
    connection: ProgressiveMcpInvocation,
    request: Record<string, unknown>,
): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
        const socket = createConnection({
            host: connection.bridgeHost,
            port: connection.bridgePort,
        })
        socket.setEncoding("utf8")
        socket.setTimeout(RELAY_TIMEOUT_MS, () => {
            socket.destroy(new Error("progressive planner relay timed out"))
        })
        let buffer = ""
        socket.once("connect", () => {
            socket.write(
                JSON.stringify({ ...request, token: connection.bridgeToken }) + "\n",
            )
        })
        socket.on("data", (chunk: string) => {
            buffer += chunk
            if (Buffer.byteLength(buffer, "utf8") > MAX_RELAY_MESSAGE_BYTES) {
                socket.destroy(
                    new Error("progressive planner relay response exceeded size limit"),
                )
                return
            }
            const newline = buffer.indexOf("\n")
            if (newline < 0) return
            const line = buffer.slice(0, newline)
            socket.destroy()
            let response: unknown
            try {
                response = JSON.parse(line)
            } catch {
                reject(new Error("progressive planner relay returned invalid JSON"))
                return
            }
            if (!isPlainRecord(response) || typeof response.ok !== "boolean") {
                reject(new Error("progressive planner relay returned an invalid response"))
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
            if (!buffer.includes("\n")) {
                reject(new Error("progressive planner relay closed without a response"))
            }
        })
    })
}

function toolSuccess(result: unknown): Record<string, unknown> {
    return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
    }
}

function toolError(message: string): Record<string, unknown> {
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    }
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
    return { jsonrpc: "2.0", id, result }
}

function jsonRpcError(
    id: unknown,
    code: number,
    message: string,
): Record<string, unknown> {
    return { jsonrpc: "2.0", id, error: { code, message } }
}

function writeJsonRpc(
    output: NodeJS.WritableStream,
    response: Record<string, unknown>,
): void {
    output.write(JSON.stringify(response) + "\n")
}

function requestId(value: unknown): string | number | null | undefined {
    if (!isPlainRecord(value) || !("id" in value)) return undefined
    return typeof value.id === "string" || typeof value.id === "number" || value.id === null
        ? value.id
        : null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function messageOf(value: unknown): string {
    if (value instanceof Error) return value.message
    if (typeof value === "string" && value.trim()) return value
    return String(value)
}
