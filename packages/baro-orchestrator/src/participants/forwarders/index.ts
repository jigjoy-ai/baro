import { AgenticEnvironment, type Participant } from "@mozaik-ai/core"

import { AgentStreamForwarder } from "./agent-stream.js"
import { CoordinationForwarder } from "./coordination.js"
import { DagForwarder } from "./dag.js"
import { FinalizationForwarder } from "./finalization.js"
import { ProgressForwarder } from "./progress.js"
import { StoryLifecycleForwarder } from "./story-lifecycle.js"
import { TokenUsageForwarder } from "./token-usage.js"

/**
 * Wire every BaroEvent forwarder into the environment. Callers wanting a
 * subset can `new XxxForwarder().join(env)` directly instead.
 */
export interface BaroEventForwarders {
    readonly dag: DagForwarder
    readonly progress: ProgressForwarder
    setLegacyReplanAuthority(authority: Participant): void
    setRuntimeReplanAuthority(authority: Participant): void
    setRepositoryAuthority(authority: Participant): void
}

export function joinBaroEventForwarders(
    env: AgenticEnvironment,
): BaroEventForwarders {
    const dag = new DagForwarder()
    const progress = new ProgressForwarder()
    const forwarders = [
        new AgentStreamForwarder(),
        new StoryLifecycleForwarder(),
        new TokenUsageForwarder(),
        progress,
        new CoordinationForwarder(),
        dag,
        new FinalizationForwarder(),
    ]
    for (const f of forwarders) f.join(env)
    return {
        dag,
        progress,
        setLegacyReplanAuthority(authority: Participant): void {
            dag.setLegacyReplanAuthority(authority)
            progress.setLegacyReplanAuthority(authority)
        },
        setRuntimeReplanAuthority(authority: Participant): void {
            dag.setRuntimeReplanAuthority(authority)
            progress.setRuntimeReplanAuthority(authority)
        },
        setRepositoryAuthority(authority: Participant): void {
            progress.setRepositoryAuthority(authority)
        },
    }
}
