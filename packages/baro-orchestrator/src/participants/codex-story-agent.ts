/**
 * CodexStoryAgent — drives a CodexCliParticipant through one story.
 * `codex exec` is one-shot (fresh process per attempt); the shared retry,
 * review, suspension, and quiescence lifecycle lives in OneShotStoryAgent.
 */

import { CodexSystem, CodexTurnEvent } from "../semantic-events.js"
import {
    CodexCliParticipant,
    type CodexRunSummary,
} from "./codex-cli-participant.js"
import {
    OneShotStoryAgent,
    type OneShotStoryCoreSpec,
    type OneShotStoryOutcome,
} from "./one-shot-story-agent.js"
import { correlationOf } from "./story-agent.js"

export interface CodexStorySpec extends OneShotStoryCoreSpec {
    model?: string
    codexBin?: string
    /**
     * Pass `--dangerously-bypass-approvals-and-sandbox`. Required: Codex's
     * `workspace-write` sandbox blocks `.git/` writes, so the agent can't
     * commit. The danger is bounded by the per-story git worktree
     * (WorktreeManager, #50), merged back only on success.
     */
    bypassSandbox?: boolean
    /**
     * Pass `--skip-git-repo-check`. Story workers run inside a per-story git
     * worktree (a valid repo), so default false; only for tests/one-offs.
     */
    skipGitRepoCheck?: boolean
}

export type CodexStoryOutcome = OneShotStoryOutcome<CodexRunSummary>

export class CodexStoryAgent extends OneShotStoryAgent<CodexRunSummary> {
    constructor(spec: CodexStorySpec) {
        super(spec, {
            name: "codex",
            createRunner: (prompt) =>
                new CodexCliParticipant(spec.id, {
                    cwd: spec.cwd,
                    prompt,
                    model: spec.model,
                    codexBin: spec.codexBin,
                    bypassSandbox: spec.bypassSandbox ?? true,
                    skipGitRepoCheck: spec.skipGitRepoCheck ?? false,
                    targetedMessageAuthority: spec.targetedMessageAuthority,
                    targetedMessageCorrelation: correlationOf(spec),
                }),
            failureSignalFrom: (event) =>
                (CodexSystem.is(event) && event.data.subtype === "error") ||
                (CodexTurnEvent.is(event) && event.data.phase === "failed")
                    ? event.data.raw
                    : undefined,
            // Codex reports turn failures explicitly, so a clean exit with no
            // failure signal is trusted as-is.
            positiveEvidenceFailure: () => null,
        })
    }

    getCurrentCodex(): CodexCliParticipant | null {
        return this.getCurrentRunner() as CodexCliParticipant | null
    }
}
