import { AgenticEnvironment } from "@mozaik-ai/core"

import { AgentStreamForwarder } from "./agent-stream.js"
import { CoordinationForwarder } from "./coordination.js"
import { FinalizationForwarder } from "./finalization.js"
import { ProgressForwarder } from "./progress.js"
import { StoryLifecycleForwarder } from "./story-lifecycle.js"
import { TokenUsageForwarder } from "./token-usage.js"

/**
 * Wire every BaroEvent forwarder into the given environment. Each
 * forwarder is independently constructible/joinable — callers that want
 * a custom subset can skip this helper and `new XxxForwarder().join(env)`
 * directly.
 */
export function joinBaroEventForwarders(env: AgenticEnvironment): void {
    const forwarders = [
        new AgentStreamForwarder(),
        new StoryLifecycleForwarder(),
        new TokenUsageForwarder(),
        new ProgressForwarder(),
        new CoordinationForwarder(),
        new FinalizationForwarder(),
    ]
    for (const f of forwarders) f.join(env)
}
