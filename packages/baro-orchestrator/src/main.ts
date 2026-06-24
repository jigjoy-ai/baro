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
    AgentTargetedMessage,
    AgentState,
    type AgentPhase,
    ClaudeSystem,
    AgentResult,
    ClaudeStreamChunk,
    ClaudeRateLimit,
    ClaudeUnknownEvent,
} from "./semantic-events.js"

export { mapClaudeEvent, type MapResult } from "./stream-json-mapper.js"

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
export { StoryResult } from "./semantic-events.js"

// The StoryExecutor seam — implement `StoryExecutor` and pass it as
// `OrchestrateConfig.executor` to run a story's agent loop somewhere other
// than in-process (the default is `LocalStoryExecutor`).
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
