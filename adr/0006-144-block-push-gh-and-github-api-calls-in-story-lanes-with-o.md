# ADR-0006: #144: Block push, gh and GitHub API calls in story lanes with one shared rule and log a StoryCommandRefused event

**Status:** Accepted
**Context:** No story lane blocks publishing commands today. The OpenAI lane has a bash guard, the Claude lane has a PreToolUse hook, and the one-shot lanes (opencode/codex/pi) have no tool hook.
**Decision:** Shared rule:
- New file packages/baro-orchestrator/src/execution/publish-guard.ts exports `publishCommandRefusal(command: string): string | null`.
- It refuses any shell segment (split on ; && || | and newlines) whose executable is `gh`, or is `git` with subcommand `push` (skipping global options such as -C <dir> and -c k=v).
- It also refuses any token containing `api.github.com`.
- The reason string is `publish commands are denied in story lanes: <segment>`.

Event: add `StoryCommandRefused { storyId: string; command: string; reason: string; harness: string }` next to where StoryResult is declared under src/events/.

Enforcement per lane:
- OpenAI: in codebase-tools.ts runBash, check before bashContainmentRejection when the new option `denyPublish: true` is set. story-factory.ts sets it for story lanes. The story agent emits the event.
- Claude: hook-bridge.ts materializeStoryHooks adds a PreToolUse matcher `Bash` that denies via the same rule. The story agent emits the event when a deny is recorded.
- One-shot lanes: harness/one-shot/story-agent.ts puts a guard bin dir first on PATH. It contains POSIX `gh` and `git` wrapper scripts; `git` forwards to the real git except for push. Refusals are appended to <guardDir>/refusals.jsonl, which the agent reads after each attempt and turns into events. Skipped on win32.

Test: an OpenAI-lane runBash call with `git push origin HEAD` and `gh pr create` is refused and emits StoryCommandRefused.
**Consequences:** The operator and finalizer are not story lanes and are unaffected. The rule must not refuse `git pull` or `git log --grep push`.
