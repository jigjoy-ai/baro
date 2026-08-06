/**
 * The lane with nothing between the model and the host.
 *
 * Both capabilities are one line here, and that is the argument rather than a
 * convenience: reading the repository is the tool set the story agents already
 * use, and calling one of our functions is calling it. The CLI lane needs a
 * spawned relay, a wire protocol and a secret to reach the same function in
 * the same process.
 */

import { createCodebaseTools } from "../../planning/adapters/codebase-tools.js"
import { MozaikModelParticipant } from "./model-participant.js"
import { pickInferenceModel } from "./pick-model.js"
import type { OpenAIConnection } from "../openai/runtime.js"
import type { Tool } from "../../runtime/mozaik.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "../interactive-participant.js"
import type {
    HostFunction,
    InteractiveLaneAdapter,
    LaneCapability,
    LaneGrant,
} from "../lane-adapter.js"

export interface MozaikLaneAdapterOptions {
    readonly backend: string
    /** Endpoint: our gateway, or any OpenAI-compatible API. */
    readonly connection?: OpenAIConnection
}

export class MozaikLaneAdapter implements InteractiveLaneAdapter {
    readonly backend: string

    constructor(private readonly options: MozaikLaneAdapterOptions) {
        this.backend = options.backend
    }

    async grant(capabilities: readonly LaneCapability[]): Promise<LaneGrant> {
        const tools: Tool[] = []
        for (const capability of capabilities) {
            if (capability.kind === "read-repo") {
                tools.push(
                    ...createCodebaseTools(capability.cwd, { includeBash: false }),
                )
                continue
            }
            tools.push(asTool(capability.fn))
        }
        return { tools, close: async () => {} }
    }

    create(
        request: InteractiveParticipantRequest,
        grant: LaneGrant,
    ): InteractiveModelParticipant<unknown> {
        return new MozaikModelParticipant({
            agentId: request.agentId,
            model: pickInferenceModel(
                request.model ?? "",
                this.options.connection,
            ),
            systemPrompt: request.systemPrompt,
            ...(grant.tools ? { tools: grant.tools } : {}),
            ...(request.targetedMessageAuthority
                ? { targetedMessageAuthority: request.targetedMessageAuthority }
                : {}),
            ...(request.targetedMessageCorrelation
                ? {
                      targetedMessageCorrelation:
                          request.targetedMessageCorrelation,
                  }
                : {}),
        }) as unknown as InteractiveModelParticipant<unknown>
    }
}

function asTool(fn: HostFunction): Tool {
    return {
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
        invoke: (args: unknown) => fn.invoke(args),
    } as unknown as Tool
}
