import { CoordinationBus, type BusMember } from "../../runtime/coordination.js"

import type { ModelInvocationPhase } from "../../telemetry/model-telemetry.js"
import type { StoryOutcomeAuthority } from "../../runtime/story-outcome-authority.js"
import { AgentStreamForwarder } from "./agent-stream.js"
import {
    CoordinationForwarder,
    type CollectiveCoordinationAuthorities,
} from "./coordination.js"
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
    setLegacyReplanAuthority(authority: BusMember): void
    setRuntimeReplanAuthority(authority: BusMember): void
    setRepositoryAuthority(authority: BusMember): void
    setInterventionAuthority(authority: BusMember): void
    sealCollectivePresentationAuthorities(
        authorities: CollectivePresentationAuthorities,
    ): void
}

export interface CollectivePresentationAuthorities
    extends CollectiveCoordinationAuthorities {
    repository: BusMember
    outcomeAuthority: StoryOutcomeAuthority
    modelTelemetryCollector: BusMember
    /** Raw Critic remains a telemetry authority, not a collective UI authority. */
    critique?: BusMember
    surgeon?: BusMember
    dialogue?: BusMember
    finalizer?: BusMember
}

const ALL_MODEL_PHASES: readonly ModelInvocationPhase[] = [
    "intake",
    "architect",
    "planner",
    "story",
    "critic",
    "surgeon",
    "dialogue",
    "verifier",
]

export function joinBaroEventForwarders(
    env: CoordinationBus,
    options: { collective?: boolean } = {},
): BaroEventForwarders {
    const dag = new DagForwarder()
    const collective = options.collective === true
    const agentStream = new AgentStreamForwarder(collective)
    const storyLifecycle = new StoryLifecycleForwarder(collective)
    const tokenUsage = new TokenUsageForwarder(collective)
    const progress = new ProgressForwarder(collective)
    const coordination = new CoordinationForwarder(
        collective,
    )
    const finalization = new FinalizationForwarder(collective)
    const forwarders = [
        agentStream,
        storyLifecycle,
        tokenUsage,
        progress,
        coordination,
        dag,
        finalization,
    ]
    for (const f of forwarders) f.join(env)
    return {
        dag,
        progress,
        setLegacyReplanAuthority(authority: BusMember): void {
            dag.setLegacyReplanAuthority(authority)
            progress.setLegacyReplanAuthority(authority)
        },
        setRuntimeReplanAuthority(authority: BusMember): void {
            dag.setRuntimeReplanAuthority(authority)
            progress.setRuntimeReplanAuthority(authority)
        },
        setRepositoryAuthority(authority: BusMember): void {
            progress.setRepositoryAuthority(authority)
        },
        setInterventionAuthority(authority: BusMember): void {
            coordination.setInterventionAuthority(authority)
        },
        sealCollectivePresentationAuthorities(
            authorities: CollectivePresentationAuthorities,
        ): void {
            coordination.sealCollectiveAuthorities(authorities)
            storyLifecycle.sealCollectiveAuthorities({
                runId: authorities.runId,
                broker: authorities.broker,
                repository: authorities.repository,
                outcomeAuthority: authorities.outcomeAuthority,
            })
            agentStream.sealCollectiveAuthorities({
                runId: authorities.runId,
                broker: authorities.broker,
                outcomeAuthority: authorities.outcomeAuthority,
            })
            tokenUsage.sealCollectiveAuthorities({
                runId: authorities.runId,
                broker: authorities.broker,
                outcomeAuthority: authorities.outcomeAuthority,
                measurementAuthorities: [
                    {
                        source: authorities.modelTelemetryCollector,
                        phases: ALL_MODEL_PHASES,
                    },
                    ...(authorities.critique
                        ? [{
                              source: authorities.critique,
                              phases: ["critic"] as const,
                          }]
                        : []),
                    ...(authorities.surgeon
                        ? [{
                              source: authorities.surgeon,
                              phases: ["surgeon"] as const,
                          }]
                        : []),
                    ...(authorities.dialogue
                        ? [{
                              source: authorities.dialogue,
                              phases: ["dialogue"] as const,
                          }]
                        : []),
                ],
            })
            progress.sealCollectiveAuthorities({
                runId: authorities.runId,
                board: authorities.board,
                broker: authorities.broker,
                repository: authorities.repository,
                quality: authorities.quality,
            })
            finalization.sealCollectiveAuthorities({
                finalizer: authorities.finalizer,
            })
        },
    }
}
