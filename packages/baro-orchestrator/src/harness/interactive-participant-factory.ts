/**
 * The one place that knows a phase can be held by more than one kind of model.
 *
 * Planning, architecture and scouting ask for a participant and get one. What
 * they never learn is which lane answered — a CLI in its own process, reaching
 * our tools back through MCP, or a loop in this process that was simply handed
 * the functions. Anything a session must know to work with either is on
 * `InteractiveModelParticipant`; anything lane-specific stops here.
 */

import { ClaudeCliParticipant } from "./claude/cli-participant.js"
import { MozaikModelParticipant } from "./mozaik/model-participant.js"
import { pickInferenceModel } from "./mozaik/pick-model.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "./interactive-participant.js"
import type { OpenAIConnection } from "./openai/runtime.js"

export type InteractiveLane = "cli" | "native"

/**
 * A CLI lane exists only for backends that are a CLI. Everything else — the
 * native OpenAI runner, an OpenAI-compatible endpoint, our own gateway — is a
 * model we can call directly, and calling it directly is both cheaper and
 * closer to the truth than shelling out to something that shells back.
 */
export function laneForBackend(backend: string): InteractiveLane {
    return backend === "claude" || backend === "codex" ||
        backend === "opencode" || backend === "pi"
        ? "cli"
        : "native"
}

export interface InteractiveParticipantFactoryOptions {
    readonly backend: string
    /** Endpoint for the native lane: our gateway, or any OpenAI-compatible API. */
    readonly connection?: OpenAIConnection
    readonly claudeBin?: string
}

export function createInteractiveParticipant(
    options: InteractiveParticipantFactoryOptions,
    request: InteractiveParticipantRequest,
): InteractiveModelParticipant<unknown> {
    if (laneForBackend(options.backend) === "native") {
        return new MozaikModelParticipant({
            agentId: request.agentId,
            model: pickInferenceModel(request.model ?? "", options.connection),
            systemPrompt: request.systemPrompt,
            ...(request.tools ? { tools: request.tools } : {}),
        }) as unknown as InteractiveModelParticipant<unknown>
    }

    return new ClaudeCliParticipant(request.agentId, {
        cwd: request.cwd,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
        includePartialMessages: true,
        permissionMode: "dontAsk",
        ...(request.targetedMessageAuthority
            ? { targetedMessageAuthority: request.targetedMessageAuthority }
            : {}),
        ...(request.targetedMessageCorrelation
            ? { targetedMessageCorrelation: request.targetedMessageCorrelation }
            : {}),
        extraArgs: [
            ...(request.cliExtraArgs ?? []),
            "--system-prompt",
            request.systemPrompt,
        ],
    }) as unknown as InteractiveModelParticipant<unknown>
}
