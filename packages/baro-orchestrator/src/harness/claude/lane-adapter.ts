/**
 * The lane that lives in another process, and what that costs.
 *
 * Reading the repository is cheap here — the CLI owns those tools and is told
 * which to allow. Calling one of OUR functions is not: a separate process
 * cannot be handed a closure, so it needs a server to call, a protocol to call
 * it with, and a secret to prove it may. That apparatus is real and it works;
 * it just belongs here, behind one capability, rather than spread through the
 * planning code that merely wanted a function called.
 *
 * The bridge is injected rather than hardcoded so this adapter states the need
 * without owning any particular relay: today the progressive planner supplies
 * one, and a general one replaces it without touching this file.
 */

import { ClaudeCliParticipant } from "./cli-participant.js"
import {
    LaneCapabilityUnsupported,
    type HostFunction,
    type InteractiveLaneAdapter,
    type LaneCapability,
    type LaneGrant,
} from "../lane-adapter.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "../interactive-participant.js"

/** Read-only repository tools, by the names this CLI knows them. */
const READ_ONLY_TOOLS = "Read,Glob,Grep"

/**
 * How host functions are made reachable from another process. Whoever owns a
 * relay implements this; the adapter only knows that one is required.
 */
export interface CliHostFunctionBridge {
    expose(functions: readonly HostFunction[]): Promise<{
        /** Args that point the CLI at the exposed functions. */
        readonly cliExtraArgs: readonly string[]
        close(): Promise<void>
    }>
}

export interface ClaudeLaneAdapterOptions {
    readonly claudeBin?: string
    /** Absent means this lane cannot grant `host-function`, and says so. */
    readonly hostFunctionBridge?: CliHostFunctionBridge
}

export class ClaudeLaneAdapter implements InteractiveLaneAdapter {
    readonly backend = "claude"

    constructor(private readonly options: ClaudeLaneAdapterOptions = {}) {}

    async grant(capabilities: readonly LaneCapability[]): Promise<LaneGrant> {
        const args: string[] = []
        const functions: HostFunction[] = []
        let readsRepo = false

        for (const capability of capabilities) {
            if (capability.kind === "read-repo") {
                readsRepo = true
                continue
            }
            functions.push(capability.fn)
        }

        if (readsRepo) args.push("--tools", READ_ONLY_TOOLS)
        args.push("--disable-slash-commands", "--strict-mcp-config")

        if (functions.length === 0) {
            // Stated explicitly: no server, and no inherited user config either.
            args.push("--safe-mode", "--mcp-config", '{"mcpServers":{}}')
            args.push("--no-session-persistence")
            return { cliExtraArgs: args, close: async () => {} }
        }

        const bridge = this.options.hostFunctionBridge
        if (!bridge) {
            throw new LaneCapabilityUnsupported(
                this.backend,
                `host-function (${functions.map((fn) => fn.name).join(", ")})`,
            )
        }
        // `--safe-mode` disables MCP servers — including the run-scoped one
        // this grant just opened, which the CLI then never spawns and the host
        // only sees as a relay nobody reached. An empty setting-source list
        // keeps ambient user config out without silencing our own server.
        const exposed = await bridge.expose(functions)
        args.push(
            "--setting-sources",
            "",
            ...exposed.cliExtraArgs,
            "--no-session-persistence",
        )
        return { cliExtraArgs: args, close: () => exposed.close() }
    }

    create(
        request: InteractiveParticipantRequest,
        grant: LaneGrant,
    ): InteractiveModelParticipant<unknown> {
        return new ClaudeCliParticipant(request.agentId, {
            cwd: request.cwd,
            ...(request.model ? { model: request.model } : {}),
            ...(request.effort ? { effort: request.effort } : {}),
            ...(this.options.claudeBin ? { claudeBin: this.options.claudeBin } : {}),
            includePartialMessages: true,
            permissionMode: "dontAsk",
            ...(request.targetedMessageAuthority
                ? { targetedMessageAuthority: request.targetedMessageAuthority }
                : {}),
            ...(request.targetedMessageCorrelation
                ? {
                      targetedMessageCorrelation:
                          request.targetedMessageCorrelation,
                  }
                : {}),
            extraArgs: [
                ...(grant.cliExtraArgs ?? []),
                ...(request.cliExtraArgs ?? []),
                "--system-prompt",
                request.systemPrompt,
            ],
        }) as unknown as InteractiveModelParticipant<unknown>
    }
}
