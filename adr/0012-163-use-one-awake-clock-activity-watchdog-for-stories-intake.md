# ADR-0012: #163: Use one awake-clock activity watchdog for stories, intake and verification

**Status:** Accepted
**Context:** IdleWatchdog (harness/liveness.ts) already runs on the awake clock. Stories use per-story silence windows with hardcoded 600s defaults, and conversation intake uses a raw setTimeout.
**Decision:** liveness.ts:
- Add `activityIdleTimeoutMs()`: env BARO_ACTIVITY_IDLE_TIMEOUT_SECS, default 600s. This N equals the old story default.
- Add `startActivityWatchdog(opts:{idleMs, onIdle}) : { pet(): void; stop(): void }`, wrapping IdleWatchdog.

New file src/harness/activity-monitor.ts:
- `watchWorktreeActivity(root, onActivity): () => void`, using fs.watch recursive and ignoring .git/.

Stories (claude/one-shot/openai story agents via story-executor):
- The watchdog is pet on file change, tool call, test start and message.

Per-story --timeout:
- storyTimeoutSecs returns undefined when unset or 0.
- Remove the hardcoded 600 defaults (claude/story-agent.ts:93, one-shot:160, openai:264, conductor.ts:267).
- When set, it adds an awake-clock wall bound via createAwakeDeadline. It is not an idle window.

Intake: conversation-intake.ts replaces its setTimeout with the watchdog, pet on streamed message chunks. Its explicit timeoutMs is kept only when passed.

Verification: runCmd pets on output chunks. Planner-bus keeps its own idleTimeoutMs option on the same class.

Tests with idleMs=200:
- A story writing a file every 50ms for 400ms is not killed.
- A silent story is killed with StoryAttemptTimeoutError.
**Consequences:** Ordered after #162 because both touch verify.ts runCmd. Tests inject idleMs and never wait real minutes.
