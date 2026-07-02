# Backend stream protocols

Observed wire formats for each coding-CLI backend, and how baro maps them onto
Mozaik bus items. Each backend has a stream mapper in
`packages/baro-orchestrator/src/` that converts one parsed JSONL envelope into
typed items (`ModelMessageItem`, `FunctionCallItem`, `FunctionCallOutputItem`,
`SemanticEvent`s from `semantic-events.ts`).

Common invariant: every input event maps to a **non-empty** array — mappers
never silently drop data. Unknown envelope types become `*UnknownEvent`s so
downstream observers (audit log, kaleidoskop replay, debug consoles) see every
envelope the backend produces.

## Claude Code (`stream-json-mapper.ts`)

Maps `claude --output-format stream-json` events. Tested against real spike
logs in `packages/baro-app/scripts/spike-logs/`.

Mapping:

| Event type         | Mapped to                                                        |
| ------------------ | ---------------------------------------------------------------- |
| `system`           | `ClaudeSystem` (subtype passthrough)                              |
| `rate_limit_event` | `ClaudeRateLimit`                                                 |
| `stream_event`     | `ClaudeStreamChunk`                                               |
| `user` (string content)  | `AgentUserMessage` (input replay)                          |
| `user` (tool_result blocks) | `FunctionCallOutputItem` per block                       |
| `assistant` `text` block   | `ModelMessageItem`                                        |
| `assistant` `tool_use` block | `FunctionCallItem`                                      |
| `result`           | `AgentResult` (wire type `claude_result`)                         |
| unknown            | `ClaudeUnknownEvent`                                              |

Notes:
- One `assistant` event can produce both text and tool_use items.
- `session_id` may appear on any event; the mapper surfaces it for the
  participant to capture.

## Codex (`codex-stream-mapper.ts`)

Maps `codex exec --json` events. Observed against real output (M1 probe
2026-05-22, codex v0.133.0 on gpt-5.5). The docs use `item.<type>` envelope
names in prose, but the actual wire format is:

```jsonl
{"type":"thread.started", "thread_id":"…"}
{"type":"turn.started"}
{"type":"item.started",   "item":{"id":"…","type":"<itemtype>", …}}
{"type":"item.updated",   "item":{"id":"…", …}}        — for streaming
{"type":"item.completed", "item":{"id":"…","type":"agent_message","text":"…"}}
{"type":"turn.completed", "usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}
{"type":"thread.completed"}  — observed only on multi-turn sessions; one-shot exec ends at turn.completed
{"type":"turn.failed",    "error":"…"}
{"type":"error",          "message":"…"}
```

The real `item.type` lives at `event.item.type`, not at envelope level. Inner
item shapes (agent_message observed; others inferred from docs, refined as
each kind is captured):

| item.type           | shape                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `agent_message`     | `{id, type, text}`                                                |
| `reasoning`         | `{id, type, text}` (per docs)                                     |
| `command_execution` | `{id, type, command, exit_code?, output?, aggregated_output?}`    |
| `file_change`       | `{id, type, path, diff?}`                                         |
| `mcp_tool_call`     | `{id, type, tool_name, arguments?, result?}`                      |
| `web_search`        | `{id, type, query, results?}`                                     |
| `plan_update`       | `{id, type, plan: […]}`                                           |

Mapping:

- Assistant-side messages → `ModelMessageItem`.
- Tool-shaped items (`command_execution`, `file_change`, `mcp_tool_call`,
  `web_search`) → `FunctionCallItem`, plus a paired `FunctionCallOutputItem`
  when the same envelope carries a result. Codex sometimes splits these into
  two events; the participant doesn't need them paired — both channels arrive
  on the bus and downstream observers (Critic, Librarian, kaleidoskop)
  reassemble.
- `thread.*` / `turn.*` lifecycle → `CodexSystem` / `CodexTurnEvent`,
  carrying the raw envelope. `CodexCliParticipant` uses these to drive
  AgentState transitions (idle → starting → running → done/failed).
- Typed channels are emitted **only on `item.completed`** — `item.started` /
  `item.updated` carry partial state and would double-count; they still go
  through `CodexItemEvent` so observers see the streaming lifecycle.
- `command_execution` envelopes can lack captured stdout (openai/codex#10141)
  but still carry an exit code; the mapper surfaces `exit_code=N` as the
  output so the `FunctionCallOutputItem` is non-empty.
- Unknown → `CodexUnknownEvent`.

`thread_id` plays the same session-correlation role as Claude's `session_id`.

## OpenCode (`opencode-stream-mapper.ts`)

Maps `opencode run --format json` events. Observed against the real binary;
each stdout line is a JSONL envelope:

```jsonl
{"type":"step_start","timestamp":N,"sessionID":"…","part":{…}}
{"type":"text","timestamp":N,"sessionID":"…","part":{"type":"text","text":"…",…}}
{"type":"tool_use","timestamp":N,"sessionID":"…","part":{"type":"tool","tool":"write","callID":"…","state":{"status":"completed","input":{…},"output":"…"}}}
{"type":"step_finish","timestamp":N,"sessionID":"…","part":{"type":"step-finish","tokens":{…},"cost":N,…}}
```

A tool invocation arrives as **one** `tool_use` event carrying both the call
(`part.state.input`) and its result (`part.state.output`) — NOT as a
`tool_call`/`tool_result` pair. The paired shape is kept as a fallback for
forward/backward compatibility but is not what the current binary emits (the
original pair-shaped assumption never matched real output, so tool activity
silently fell through to `OpenCodeUnknownEvent`, breaking function-call
delivery and tool-based success checks).

Mapping:

| Event type    | Mapped to                                                        |
| ------------- | ----------------------------------------------------------------- |
| `step_start`  | `OpenCodeSystem` (subtype `step_start`)                            |
| `text`        | `ModelMessageItem` + `OpenCodeStepEvent`                           |
| `tool_use`    | `FunctionCallItem` (+ `FunctionCallOutputItem` once completed) + `OpenCodeStepEvent`(s) |
| `tool_call` / `tool_result` | legacy paired-shape fallback                        |
| `step_finish` | `OpenCodeSystem` (subtype `step_finish`, token/cost metadata in `raw`) |
| unknown       | `OpenCodeUnknownEvent`                                             |

## Pi (`pi-stream-mapper.ts`)

Maps `pi --mode json -p --no-session` events. Observed against real output;
each stdout line is a JSONL envelope:

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"ISO","cwd":"…"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user"|"assistant","content":[…]}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…",…},"message":{…}}
{"type":"tool_execution_start"}
{"type":"tool_execution_update"}
{"type":"tool_execution_end","result":…}
{"type":"message_end","message":{"role":"assistant","content":[…],"usage":{…}}}
{"type":"turn_end","message":{…},"toolResults":[…]}
{"type":"agent_end","messages":[…],"willRetry":false}
```

Pi differs from OpenCode in several important ways:

- Session id lives only on the `session` event (field `id`), not on every
  envelope.
- Assistant content arrives as streaming deltas via `message_update`, then is
  re-delivered as a finalised block list in `message_end`. The mapper emits
  `PiItemEvent` for every delta (so nothing is dropped from the bus) but emits
  `ModelMessageItem` / `FunctionCallItem` only from the final `message_end` to
  avoid duplicates.
- Tool calls and their results are split across separate events: `toolCall`
  blocks (field `id`) appear in `message_end` content, while actual outputs
  appear in `tool_execution_end` (field `toolCallId`). Those two ids are
  equal, so call/output reconciliation is exact; fallback fields are kept only
  for resilience against shape drift.

Observed `tool_execution_end` shape:

```jsonl
{"type":"tool_execution_end","toolCallId":"call_…","toolName":"bash","result":{"content":[{"type":"text","text":"hello\n"}]},"isError":false}
```

Mapping:

| Event type              | Mapped to                                                  |
| ----------------------- | ----------------------------------------------------------- |
| `session`               | `PiSystem` subtype `session` (+ captures id)                 |
| `agent_start`           | `PiSystem` subtype `agent_start`                             |
| `turn_start`            | `PiSystem` subtype `turn_start`                              |
| `message_start`         | `PiTurnEvent` turnType `message_start`                       |
| `message_update`        | `PiItemEvent` (itemType from `assistantMessageEvent.type`: `text_*` → `text`, `thinking_*` → `thinking`, `toolcall_*` → `tool_call`, other → raw subtype) |
| `message_end` (assistant) | `ModelMessageItem`(s) + `FunctionCallItem`(s) from content blocks + `PiTurnEvent` `message_end` |
| `message_end` (user)    | `PiTurnEvent` `message_end` (lifecycle record only)          |
| `tool_execution_start`  | `PiItemEvent` itemType `tool_start`                          |
| `tool_execution_update` | `PiItemEvent` itemType `tool_update`                         |
| `tool_execution_end`    | `FunctionCallOutputItem` (callId from `toolCallId`, output from `result.content[].text`) + `PiItemEvent` itemType `tool_result` |
| `turn_end`              | `PiTurnEvent` turnType `turn_end`                            |
| `agent_end`             | `PiSystem` subtype `agent_end`                               |
| unknown                 | `PiUnknownEvent`                                             |

Notes:
- Distinct itemTypes per tool lifecycle phase (`tool_start` / `tool_update` /
  `tool_result`) let itemType-filtering observers distinguish phases without
  reaching into the opaque `raw` field.
- Pi's `session` envelope carries an ISO-8601 *string* timestamp (unlike
  OpenCode's numeric one) and `message_end` carries none at all — synthetic-id
  fallbacks accept both.
