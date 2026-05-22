import { type BaseObserver } from "@mozaik-ai/core"

import { AgentLogForwarder } from "./agent-log.js"
import { CoordinationForwarder } from "./coordination.js"
import { FinalizationForwarder } from "./finalization.js"
import { ProgressForwarder } from "./progress.js"
import { StoryLifecycleForwarder } from "./story-lifecycle.js"
import { TokenUsageForwarder } from "./token-usage.js"

export { AgentLogForwarder } from "./agent-log.js"
export { CoordinationForwarder } from "./coordination.js"
export { FinalizationForwarder } from "./finalization.js"
export { ProgressForwarder } from "./progress.js"
export { StoryLifecycleForwarder } from "./story-lifecycle.js"
export { TokenUsageForwarder } from "./token-usage.js"

export function createTuiForwarders(): BaseObserver[] {
    return [
        new ProgressForwarder(),
        new StoryLifecycleForwarder(),
        new TokenUsageForwarder(),
        new CoordinationForwarder(),
        new FinalizationForwarder(),
        new AgentLogForwarder(),
    ]
}
