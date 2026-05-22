import { BaseObserver } from "@mozaik-ai/core"

import { AgentLogForwarder } from "./agent-log.js"
import { CoordinationForwarder } from "./coordination.js"
import { FinalizationForwarder } from "./finalization.js"
import { ProgressForwarder } from "./progress.js"
import { StoryLifecycleForwarder } from "./story-lifecycle.js"
import { TokenUsageForwarder } from "./token-usage.js"

export {
    AgentLogForwarder,
    CoordinationForwarder,
    FinalizationForwarder,
    ProgressForwarder,
    StoryLifecycleForwarder,
    TokenUsageForwarder,
}

export const TUI_FORWARDERS: ReadonlyArray<new () => BaseObserver> = [
    StoryLifecycleForwarder,
    TokenUsageForwarder,
    ProgressForwarder,
    CoordinationForwarder,
    FinalizationForwarder,
    AgentLogForwarder,
]
