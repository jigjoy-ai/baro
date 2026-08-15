# TUI protocol v3 — a versioned contract for external consumers

v2 (docs/tui-protocol-v2.md) made the stream structured; v3 makes it a
contract something outside this repository can build on. The audience grew:
besides the Rust TUI and the cloud control plane, the stream is now read by
external harness adapters (e.g. a DeepSeek Harness plugin) that map it into
their own progress and result vocabularies.

Everything in v2 still holds. v3 adds:

## 1. Every line carries `ts`

`emit()` stamps each line with an ISO-8601 `ts` at the moment of emission.
A consumer that sees only this stream can now tell how long anything took.
Consumers MUST ignore unknown fields (the Rust TUI's serde does; assertions
that compare exact event shapes strip `ts` in one shared capture helper).

## 2. The stream names its version

The `init` event carries `protocol: 3`. A consumer dispatches on it instead
of sniffing field presence. Absent `protocol` means v2 or older.

## 3. `done` carries a machine-readable classification

`done.abort_code?: string` is present when every incomplete story's terminal
failure shared one `StoryFailureCode` (src/events/execution.ts). A mixture of
codes — or any story that failed without one — yields no `abort_code`: a
mixed run is prose (`abort_reason`), not a classification. Consumers mapping
to their own terminal vocabulary (e.g. dsh `stopReason`) read `abort_code`
and fall back to `error`-like handling when it is absent.

`token_ceiling` is the code for a model that hit its context or output-token
ceiling before finishing (Codex `contextWindowExceeded`, Anthropic "prompt is
too long", output-token limits) — external systems typically map it to their
`max-tokens` variant.

## 4. Tool activity is truthful about the tool

`activity.kind: "tool_call"` events classify `tool` as `read | bash | other`
(plus `write` on `file_change`). Lane tool names are matched
case-insensitively — Claude Code sends `Bash`/`Edit`/`Write`, Codex sends
`shell`/`edit` — and a tool the classifier does not recognize is labeled
`other`, never guessed. `text` carries the command (bash) or `<name> <target>`.

## 5. Milestone subset

Two consumer classes read this stream. A live view (the TUI, a jobs panel)
wants everything. A record of what happened — a parent session log, a shared
trajectory — wants only events that state an outcome someone certified, in
an order that is meaningful even though concurrent stories interleave
arbitrarily between them.

The milestone subset is defined BY TYPE, so filtering is a list membership
test, not a schema change:

| type | why it is a milestone |
|---|---|
| `init` | the run's identity, mode, and story graph |
| `story_start` | a story took its lease |
| `story_suspended` | a story yielded to a prerequisite (cooperative) |
| `critique` | the Critic's verdict — certification, not activity |
| `story_merged` / `merge_failed` | the merge gate's outcome |
| `story_complete` / `story_error` | a story's terminal state |
| `level_started` / `level_completed` / `recovery_started` | graph progress |
| `replan` | the graph itself changed |
| `progress` | completed/total snapshot |
| `push_status` / `finalize_start` / `finalize_complete` | integration outcome |
| `done` | the run's terminal state, stats, and classification |

Everything else (`activity`, `story_log`, `token_usage`, `model_usage`,
`routed`, `dag`, …) is the live feed: valuable to watch, wrong to archive as
a linear record — interleaving concurrent stories into one sequence
manufactures an ordering the execution never had.
