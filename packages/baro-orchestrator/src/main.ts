/** @baro/orchestrator — public entry point of the package. */

export {
    AgentTargetedMessage,
    ConversationRequested,
    ConversationResponded,
    ConversationFailed,
    type ConversationRequestedData,
    type ConversationRespondedData,
    type ConversationFailedData,
    type ConversationAction,
    AgentState,
    type AgentPhase,
    ClaudeSystem,
    AgentResult,
    ClaudeStreamChunk,
    ClaudeRateLimit,
    ClaudeUnknownEvent,
    AgentTurnCompleted,
    type AgentTurnCompletedData,
    ModelInvocationMeasured,
    StoryQualityCompleted,
    StoryQualityTimedOut,
    type StoryQualityCompletedData,
    type StoryQualityTimedOutData,
    RunVerificationTimedOut,
} from "./semantic-events.js"

export {
    DialogueAgent,
    DIALOGUE_SYSTEM_PROMPT,
    type DialogueAgentOptions,
    type DialogueResponder,
    type DialogueResponderInput,
} from "./participants/dialogue-agent.js"

export {
    createDialogueResponder,
    type DialogueBackend,
    type CreateDialogueResponderOptions,
} from "./participants/dialogue-responder.js"

export { DialogueForwarder } from "./participants/forwarders/dialogue.js"

export {
    AgentTurnProjector,
} from "./participants/agent-turn-projector.js"

export {
    AcceptanceGate,
    type AcceptanceGateOptions,
} from "./participants/acceptance-gate.js"

export {
    knownMetric,
    unknownMetric,
    notApplicableMetric,
    mergeMetric,
    reduceModelTelemetry,
    type Metric,
    type MetricSource,
    type UnknownMetricReason,
    type ModelInvocationPhase,
    type ModelInvocationStatus,
    type ModelInvocationGranularity,
    type ModelTelemetryProducer,
    type ModelTokenMetrics,
    type ModelCostMetrics,
    type ModelInvocationEvidence,
    type ModelInvocationMeasuredData,
    type ReducedModelInvocation,
    type ModelTelemetryReduction,
} from "./model-telemetry.js"

export type {
    RunnerInvocationObservation,
    RunnerInvocationObserver,
} from "./runner-invocation.js"
export {
    runnerMeasurement,
    type RunnerMeasurementContext,
} from "./runner-measurement.js"

export { mapClaudeEvent, type MapResult } from "./stream-json-mapper.js"

export {
    createVerifyPlan,
    recommendedVerifyTimeoutMs,
    verifyBuild,
    type VerifyBuildOptions,
    type VerifyCommandResult,
    type VerifyCommandSpec,
    type VerifyPlan,
    type VerifyResult,
} from "./verify.js"

export {
    mapCodexEvent,
    type CodexMapResult,
    type MappedCodexItem,
} from "./codex-stream-mapper.js"

export {
    ClaudeCliParticipant,
    type ClaudeCliParticipantOptions,
    type ClaudeRunSummary,
} from "./participants/claude-cli-participant.js"

export {
    CodexCliParticipant,
    type CodexCliParticipantOptions,
    type CodexRunSummary,
} from "./participants/codex-cli-participant.js"

export {
    CodexStoryAgent,
    type CodexStorySpec,
    type CodexStoryOutcome,
} from "./participants/codex-story-agent.js"

export {
    ModelTelemetryCollector,
    type ModelTelemetryCollectorOptions,
} from "./participants/model-telemetry-collector.js"

export {
    OpenCodeCliParticipant,
    type OpenCodeCliParticipantOptions,
    type OpenCodeRunSummary,
} from "./participants/opencode-cli-participant.js"

export {
    OpenCodeStoryAgent,
    type OpenCodeStorySpec,
    type OpenCodeStoryOutcome,
} from "./participants/opencode-story-agent.js"

export {
    mapOpenCodeEvent,
    type OpenCodeMapResult,
    type MappedOpenCodeItem,
} from "./opencode-stream-mapper.js"

export { runOpenCodeOneShot, type RunOpenCodeOneShotOptions } from "./opencode-one-shot.js"

export {
    PiCliParticipant,
    type PiCliParticipantOptions,
    type PiRunSummary,
} from "./participants/pi-cli-participant.js"

export {
    PiStoryAgent,
    type PiStorySpec,
    type PiStoryOutcome,
} from "./participants/pi-story-agent.js"

export {
    mapPiEvent,
    type PiMapResult,
    type MappedPiItem,
} from "./pi-stream-mapper.js"

export { runPiOneShot, type RunPiOneShotOptions } from "./pi-one-shot.js"

export { Auditor, type AuditorOptions } from "./participants/auditor.js"

export {
    Cartographer,
    type CartographerOptions,
    type Frame,
} from "./participants/cartographer.js"

export {
    StoryAgent,
    type StorySpec,
    type StoryOutcome,
} from "./participants/story-agent.js"
export {
    OpenAIStoryAgent,
    type OpenAIStoryAgentOptions,
} from "./participants/openai-story-agent.js"
export { StoryResult } from "./semantic-events.js"

// The StoryExecutor seam: pass a custom implementation as
// `OrchestrateConfig.executor` to run story agent loops out of process.
export {
    LocalStoryExecutor,
    type StoryExecutor,
    type StoryExecution,
    type StoryExecOpts,
} from "./participants/story-executor.js"
export { type StoryRoute, type Backend } from "./routing.js"
export { type StorySpawnRequestData } from "./semantic-events.js"

export {
    Conductor,
    type ConductorOptions,
    type ConductorRunSummary,
} from "./participants/conductor.js"
export { ConductorState } from "./semantic-events.js"
export {
    CoordinationModeSelected,
    WorkerCapabilityAdvertised,
    WorkOffered,
    WorkBid,
    WorkBidWindowClosed,
    WorkClaimed,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkLeaseExpired,
    WorkDiscovered,
    RuntimeReplanProposed,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    PeerHelpRequested,
    CollaborationNote,
    StoryIntegrationRequested,
    type CoordinationMode,
    type WorkBidData,
    type WorkBidEstimateData,
    type WorkRouteDescriptor,
    type RuntimeReplanMutation,
    type RuntimeReplanCorrelationData,
    type RuntimeReplanProposedData,
    type RuntimeReplanAppliedData,
    type RuntimeReplanRejectedData,
    type RuntimeReplanRejectionCode,
} from "./semantic-events.js"
export {
    snapshotRuntimeReplanMutation,
    validateRuntimeReplanMutation,
    type RuntimeReplanValidationOptions,
    type RuntimeReplanValidationResult,
} from "./runtime-replan.js"
export {
    CollectiveBoard,
    type CollectiveBoardOptions,
} from "./participants/collective-board.js"
export {
    LeaseBroker,
    type LeaseBrokerOptions,
} from "./participants/lease-broker.js"
export {
    expectedVerifiedCostUsd,
    isValidWorkBidEstimate,
    selectWorkBid,
    type WorkBidCandidate,
    type WorkBidEstimate,
    type WorkBidPolicy,
} from "./work-market.js"
export {
    RunVerifier,
    type RunVerifierOptions,
} from "./participants/run-verifier.js"
export {
    RunVerificationRequested,
    RunVerificationCompleted,
    type RunVerificationStatus,
    type VerificationCommandEvidence,
} from "./semantic-events.js"

export {
    type PrdFile,
    type PrdStory,
    loadPrd,
    savePrd,
    savePrdAtomic,
    normalizePrd,
    markStoryPassed,
    buildDefaultStoryPrompt,
} from "./prd.js"

export {
    buildDag,
    type DagNode,
    type DagLevel,
    type BuildOptions as DagBuildOptions,
} from "./dag.js"

export {
    GitGate,
    createOrCheckoutBranch,
    getCurrentBranch,
    getGitFileStats,
    getHeadSha,
    gitPushWithRetry,
    isInsideGitRepo,
    safePullRebase,
    type GitFileStats,
    type GitPushOptions,
} from "./git.js"

export {
    orchestrate,
    validateCollectiveWorkers,
    type CollectiveWorkerCandidateConfig,
    type OrchestrateConfig,
    type OrchestrateResult,
} from "./orchestrate.js"

export {
    emit as emitBaroEvent,
    subscribeCommands as subscribeTuiCommands,
    type BaroEvent,
    type BaroCommand,
} from "./tui-protocol.js"

export {
    Operator,
    type OperatorCommand,
    type OperatorHooks,
} from "./participants/operator.js"

export {
    Librarian,
    type LibrarianOptions,
} from "./participants/librarian.js"

export {
    Sentry,
    type SentryOptions,
} from "./participants/sentry.js"

export {
    Knowledge,
    Coordination,
    Critique,
    Replan,
    type ReplanStoryAdd,
} from "./semantic-events.js"

export {
    Critic,
    type CriticOptions,
} from "./participants/critic.js"

export {
    Surgeon,
    type SurgeonOptions,
    type PrdSnapshot,
} from "./participants/surgeon.js"
