/**
 * @baro/orchestrator — TypeScript Mozaik orchestrator that replaces baro's
 * Rust executor. This module is the public entry point of the package.
 *
 * Phase 1 milestone A: exports the building blocks needed to run a single
 * story end-to-end (ClaudeCliParticipant, Auditor, Cartographer, custom
 * ContextItem types, DAG helpers). Conductor / TUI bridge / Operator
 * land in milestone B.
 */

export {
    AgentTargetedMessageItem,
    AgentStateItem,
    type AgentPhase,
    ClaudeSystemItem,
    AgentResultItem,
    ClaudeStreamChunkItem,
    ClaudeRateLimitItem,
    ClaudeUnknownEventItem,
} from "./types.js"

export { mapClaudeEvent, type MapResult } from "./stream-json-mapper.js"

export {
    ClaudeCliParticipant,
    type ClaudeCliParticipantOptions,
    type ClaudeRunSummary,
} from "./participants/claude-cli-participant.js"

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
export { StoryResult } from "./semantic-events.js"

export {
    Conductor,
    type ConductorOptions,
    type ConductorRunSummary,
} from "./participants/conductor.js"
export { ConductorState } from "./semantic-events.js"

export {
    type PrdFile,
    type PrdStory,
    loadPrd,
    savePrd,
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
    KnowledgeItem,
    CoordinationItem,
    CritiqueItem,
    ReplanItem,
    type ReplanStoryAdd,
} from "./types.js"

export {
    Critic,
    type CriticOptions,
} from "./participants/critic.js"

export {
    Surgeon,
    type SurgeonOptions,
    type PrdSnapshot,
} from "./participants/surgeon.js"
