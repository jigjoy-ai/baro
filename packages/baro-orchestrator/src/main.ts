/** @baro/orchestrator — public entry point of the package. */

export {
    AgentTargetedMessage,
    ConversationRequested,
    ConversationResponded,
    ConversationFailed,
    FrontDoorConversationRequested,
    FrontDoorConversationCompleted,
    FrontDoorConversationFailed,
    RepositoryContextRequested,
    RepositoryContextProvided,
    RepositoryContextFailed,
    type ConversationRequestedData,
    type ConversationRespondedData,
    type ConversationFailedData,
    type ConversationAction,
    type FrontDoorConversationRequestedData,
    type FrontDoorConversationCompletedData,
    type FrontDoorConversationFailedData,
    type RepositoryContextRequestedData,
    type RepositoryContextProvidedData,
    type RepositoryContextFailedData,
    type RepositoryContextFailureCode,
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
    StoryQualityReverificationRequested,
    StoryQualityTimedOut,
    type StoryQualityCompletedData,
    type StoryQualityReverificationRequestedData,
    type StoryQualityTimedOutData,
    RunVerificationTimedOut,
    GoalStoryInvariantMapped,
    GoalInvariantChallengeRaised,
    GoalInvariantChallengeResolved,
    GoalInvariantRemediationProposed,
    GoalInvariantRemediationAdmitted,
    GoalLedgerProjectionUpdated,
    GoalLedgerProjectionPersisted,
    GoalCompletionCheckRequested,
    GoalAggregateReviewRequested,
    GoalAggregateReviewCompleted,
    GoalCompletionAttested,
    type GoalStoryInvariantMappedData,
    type GoalInvariantChallengeRaisedData,
    type GoalInvariantChallengeResolvedData,
    type GoalInvariantRemediationProposedData,
    type GoalInvariantRemediationAdmittedData,
    type GoalLedgerProjectionUpdatedData,
    type GoalLedgerProjectionPersistedData,
    type GoalCompletionCheckRequestedData,
    type GoalAggregateReviewRequestedData,
    type GoalAggregateReviewCompletedData,
    type GoalCompletionAttestedData,
} from "./semantic-events.js"

export {
    GoalGuardian,
    CollectiveGoalLedger,
    type GoalGuardianOptions,
} from "./participants/goal-guardian.js"

export {
    GoalInvariantReviewer,
    GOAL_AGGREGATE_REVIEW_SYSTEM_PROMPT,
    type GoalInvariantReviewerOptions,
} from "./participants/goal-invariant-reviewer.js"

export {
    GOAL_CONTRACT_SCHEMA_VERSION,
    GoalInvariantLedger,
    deriveGoalContract,
    renderGoalContractPrompt,
    normalizeGoalLedgerProjection,
    type GoalContract,
    type GoalInvariant,
    type GoalInvariantKind,
    type GoalStoryInvariantMapping,
    type GoalLedgerAssessment,
    type GoalLedgerProjection,
    type GoalIntegrationEvidence,
    type GoalQualityEvidence,
    type GoalInvariantChallenge,
    type GoalInvariantChallengeRecord,
    type GoalInvariantChallengeResolution,
    type GoalInvariantRemediationBinding,
    type DisplacedGoalRemediation,
    type GoalProtocolIssue,
} from "./runtime/goal-contract.js"

export {
    ARCHITECTURE_OBLIGATION_SCHEMA_VERSION,
    ARCHITECTURE_OBLIGATION_FENCE,
    ArchitectureObligationContractError,
    parseArchitectureObligationContract,
    bindArchitectureObligationContract,
    architectureObligationsFromDecision,
    renderArchitectureObligationCriterion,
    validateArchitectureObligationCoverage,
    validatePrdArchitectureObligationCoverage,
    obligationMappingsForStories,
    type ArchitectureObligationV1,
    type ArchitectureObligationContractV1,
    type StoryObligationMapping,
    type ArchitectureObligationCoverageMode,
    type ArchitectureObligationCoverageResult,
} from "./planning/architecture-obligation-contract.js"

export {
    createGoalAggregateReviewBasis,
    normalizeGoalAggregateReviewEvidence,
    type GoalAggregateInvariantBasis,
    type GoalAggregateInvariantReview,
    type GoalAggregateReviewBasis,
    type GoalAggregateReviewEvidence,
    type GoalAggregateReviewStatus,
} from "./runtime/goal-aggregate-review.js"

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
    DEFAULT_ACCEPTANCE_REVERIFICATIONS,
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

export * from "./billing/index.js"

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
    MAX_DECLARED_VERIFY_COMMANDS,
    MAX_FINAL_ADDED_VERIFY_COMMANDS,
    recommendedMergedVerifyTimeoutMs,
    recommendedVerifyTimeoutMs,
    verifyBuild,
    type DeclaredTestRequirement,
    type JavaScriptPackageManager,
    type VerifyBuildOptions,
    type VerifyCommandResult,
    type VerifyCommandSpec,
    type VerifyPlan,
    type VerifyPlanOptions,
    type VerifyResult,
    type VerifyJavaScriptPackageManager,
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
    WorkOfferRetractionRequested,
    WorkOfferRetractionResolved,
    WorkBid,
    RouteEstimateUpdated,
    WorkBidWindowClosed,
    WorkClaimed,
    WorkLeaseGranted,
    WorkLeaseReleased,
    WorkLeaseExpired,
    WorkDiscovered,
    WorkBlocked,
    WorkBlockAccepted,
    WorkBlockRejected,
    WorkSuspended,
    ConversationDelegationProposed,
    RuntimeReplanProposed,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    PlanningStreamOpened,
    PlanFragmentProposed,
    PlanFragmentAdmitted,
    PlanFragmentRejected,
    PlanningStreamCompleted,
    PlanningStreamFailed,
    PlanningStreamClosed,
    ReplanApplied,
    PeerHelpRequested,
    CollaborationNote,
    StoryIntegrationRequested,
    type CoordinationMode,
    type WorkOfferRetractionRequestedData,
    type WorkOfferRetractionResolvedData,
    type WorkBidData,
    type WorkBidEstimateData,
    type RouteEstimateUpdatedData,
    type WorkRouteDescriptor,
    type ConversationDelegatedStory,
    type ConversationDelegationProposedData,
    type RuntimeReplanMutation,
    type RuntimeReplanCorrelationData,
    type RuntimeReplanProposedData,
    type RuntimeReplanAppliedData,
    type RuntimeReplanRejectedData,
    type RuntimeReplanRejectionCode,
    type WorkBlockedData,
    type WorkBlockAcceptedData,
    type WorkBlockRejectedData,
    type WorkBlockRejectionCode,
    type WorkSuspendedData,
    type PlanningStreamOpenedData,
    type PlanFragmentProposedData,
    type PlanFragmentAdmittedData,
    type PlanFragmentRejectedData,
    type PlanFragmentRejectionCode,
    type PlanningStreamCompletedData,
    type PlanningStreamFailedData,
    type PlanningStreamClosedData,
    type ReplanData,
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
    type PrdProgressivePlanningState,
    type PrdPlanningFragmentDecision,
    type PrdCollectiveProtocolState,
    loadPrd,
    savePrd,
    savePrdAtomic,
    normalizePrd,
    markStoryPassed,
    buildDefaultStoryPrompt,
} from "./prd.js"

export { PlanningFeed } from "./participants/planning-feed.js"
export {
    PROGRESSIVE_PLAN_SCHEMA_VERSION,
    ProgressivePlanContractError,
    openProgressivePlanSession,
    restoreProgressivePlanSession,
    reconcileProgressivePlanStories,
    validateProgressivePlanFragment,
    validateProgressivePlannerStory,
    type ProgressivePlanFragmentV1,
    type ProgressivePlanAdmissionV1,
    type ProgressivePlanSnapshotV1,
} from "./planning/progressive-plan.js"

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
    type GatewayBillingConfig,
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
    CONVERSATION_SCHEMA_VERSION,
    ConversationContractError,
    assertCorrelationId,
    goalEnvelopeFingerprint,
    parseConversationResponse,
    validateConversationResponse,
    validateGoalEnvelope,
    type ClarificationQuestion,
    type ConversationCorrelation,
    type ConversationResponse,
    type ConversationResponseKind,
    type GoalEnvelope,
} from "./session/conversation-contract.js"
export {
    CONVERSATION_INTAKE_SYSTEM_PROMPT,
    ConversationIntake,
    conversationResponseHistoryText,
    type ConversationHistoryEntry,
    type ConversationIntakeOptions,
    type ConversationIntakeSnapshot,
    type ConversationRequest,
    type ConversationRequestIntent,
    type ConversationResponder,
    type ConversationResponderBackend,
    type ConversationResponderInput,
    type ConversationResponderResult,
} from "./session/conversation-intake.js"
export {
    REPOSITORY_BRIEF_SCHEMA_VERSION,
    MAX_REPOSITORY_BRIEF_BYTES,
    RepositoryBriefError,
    validateRepositoryBriefV1,
    validateRepositoryEvidencePath,
    type RepositoryBriefV1,
    type RepositoryFactV1,
    type RepositoryFactConfidence,
} from "./session/repository-brief.js"
export {
    DeterministicRepositoryScanner,
    repositoryDirectoryIsIgnored,
    repositoryPathIsSensitive,
    repositoryTextPathIsEligible,
    type RepositoryContextScanner,
    type RepositoryContextScanRequest,
    type DeterministicRepositoryScannerOptions,
} from "./session/repository-scanner.js"
export {
    AUTONOMOUS_REPOSITORY_SCOUT_SYSTEM_PROMPT,
    AutonomousRepositoryScanner,
    type AutonomousRepositoryScannerOptions,
    type RepositoryScoutResponder,
    type RepositoryScoutResponderInput,
    type RepositoryScoutResponderResult,
} from "./session/autonomous-repository-scout.js"
export {
    createReadOnlyRepositoryScoutTools,
    validateInspectableRepositoryEvidencePath,
    validateRepositoryGlobPattern,
    validateRepositoryResearchDirectoryPath,
    validateRepositorySearchPattern,
} from "./session/repository-research-tools.js"
export {
    ConversationTurnHost,
    ConversationIntakeParticipant,
    RepositoryScoutParticipant,
    repositoryContextRequestId,
    runFrontDoorConversationTurn,
    type FrontDoorConversationTurn,
    type ConversationTurnHostOptions,
    type ConversationIntakeParticipantOptions,
    type RepositoryScoutParticipantOptions,
    type RunFrontDoorConversationTurnOptions,
} from "./session/conversation-frontdoor.js"
export {
    SessionLifecycle,
    SessionLifecycleError,
    type SessionLifecycleSnapshot,
    type SessionPhase,
    type SessionPhaseChange,
} from "./session/session-lifecycle.js"
export {
    CONVERSATION_CONTEXT_SCHEMA_VERSION,
    MAX_CONVERSATION_CONTEXT_BYTES,
    MAX_CONVERSATION_CONTEXT_HISTORY,
    ConversationContextError,
    assertConversationContextBinding,
    loadConversationContextFile,
    parseConversationContextSnapshot,
    validateConversationContextSnapshot,
    type ConversationContextBinding,
    type ConversationContextHistoryEntry,
    type ConversationContextPhase,
    type ConversationContextSnapshot,
} from "./session/conversation-context.js"
export {
    ProcessSessionHost,
    type HostedRunResult,
    type ProcessIsolatedRun,
    type ProcessRunContext,
    type ProcessRunFactory,
    type ProcessRunOutcome,
    type ProcessSessionHostOptions,
} from "./session/process-session-host.js"

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
