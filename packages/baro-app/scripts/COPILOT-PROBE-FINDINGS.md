# Probe findings — GitHub Copilot CLI `--output-format json` JSONL schema

Date: 2026-06-05
Story: S1 — Probe Copilot CLI JSONL schema
Probe: `packages/baro-app/scripts/probe-copilot.ts`
Binary: `GitHub Copilot CLI 1.0.59` (winget install, Windows 11)
Logs: `packages/baro-app/scripts/spike-logs/copilot-*.jsonl`
  - `copilot-1780651997320.jsonl` — text-only prompt (11 types, 13 lines)
  - `copilot-1780652024541.jsonl` — tool-triggering prompt (14 types, 43 lines)

## Result: schema captured — mapper can now be written against real field names

The `-p ... --output-format json` stream is line-delimited JSON (JSONL),
one event per stdout line, process exits when done (`exitCode 0` on
success). The argv from the design spec works verbatim:

```
copilot -p <PROMPT> --output-format json --yolo --no-ask-user [--model <M>] [--reasoning-effort <E>]
```

The prompt is passed as a single argv element via `spawn()` (no shell);
the Windows whitespace-tokenisation bug (github/copilot-cli#3186) did not
bite — the multi-word prompt arrived intact.

## Common envelope

Every event except `result` shares this shape:

```jsonc
{ "type": "<namespace.event>", "data": { ... }, "id": "<uuid>",
  "timestamp": "<ISO>", "parentId": "<uuid>", "ephemeral": true? }
```

- `type` is **dotted** (`assistant.message`, `tool.execution_start`,
  `session.tools_updated`) — unlike Codex/OpenCode's flat names.
- `ephemeral: true` marks streaming/noise events (deltas, loaders,
  background-task churn). This is the Copilot analogue of Claude's
  `stream_event` — safe to filter/batch; not semantically interesting.
- `parentId` links events into a tree; `id` is per-event.
- **`result` is the exception**: it is FLAT — no `data`/`id`/`parentId`.
  Its fields (`sessionId`, `exitCode`, `usage`) sit at the top level.

## Distinct event types catalogued (14 across both runs)

| `type` | ephemeral | role | key `data` fields |
|---|---|---|---|
| `session.mcp_server_status_changed` | yes | lifecycle | `serverName`, `status` |
| `session.mcp_servers_loaded` | yes | lifecycle | `servers[]` |
| `session.skills_loaded` | yes | lifecycle | `skills[]` |
| `session.tools_updated` | yes | lifecycle | `model` |
| `session.background_tasks_changed` | yes | lifecycle | (task list) |
| `user.message` | no | input replay | `content`, `transformedContent`, `interactionId`, `parentAgentTaskId` |
| `assistant.turn_start` | no | lifecycle | `turnId`, `interactionId` |
| `assistant.message_start` | yes | stream | `messageId`, `phase` |
| `assistant.message_delta` | yes | stream | `messageId`, `deltaContent` |
| `assistant.message` | no | **assistant text + tool calls** | `messageId`, `model`, `content`, `toolRequests[]`, `phase`, `outputTokens` |
| `assistant.turn_end` | no | lifecycle | `turnId` |
| `tool.execution_start` | no | **tool call** | `toolCallId`, `toolName`, `arguments`, `model`, `turnId` |
| `tool.execution_complete` | no | **tool result** | `toolCallId`, `success`, `result{content,detailedContent}`, `toolTelemetry` |
| `result` | n/a (flat) | **terminal** | `sessionId`, `exitCode`, `usage{premiumRequests,totalApiDurationMs,sessionDurationMs,codeChanges}` |

## Mapping contract for `mapCopilotEvent(agentId, event)` → `{ items, sessionId }`

Field names below are the **observed** ones — write the mapper against
these, not against guesses. Until each kind below is wired, it falls
through to `CopilotUnknownEvent` (project invariant: never drop).

- **Assistant text** → `ModelMessageItem.rehydrate({ text })`
  - text = `assistant.message` `data.content` (the final, non-ephemeral
    message). Ignore `assistant.message_delta`/`message_start`
    (ephemeral partial deltas) for the non-streaming mapper.
- **Tool call** → `FunctionCallItem.rehydrate({ callId, name, args })`
  - Two sources carry the same call: `assistant.message`
    `data.toolRequests[]` (each `{ toolCallId, name, arguments, type,
    intentionSummary? }`) AND the standalone `tool.execution_start`
    (`{ toolCallId, toolName, arguments }`). **Prefer
    `tool.execution_start`** — `callId = data.toolCallId`,
    `name = data.toolName`, `args = data.arguments`. (Map from one source
    only to avoid emitting each call twice.)
- **Tool result** → `FunctionCallOutputItem.create(callId, output)`
  - From `tool.execution_complete`: `callId = data.toolCallId`,
    `output = data.result.content` (string; `detailedContent` is a
    richer variant). `data.success` is a boolean status.
- **Session / turn lifecycle** → `CopilotSystem`
  - all `session.*`, `assistant.turn_start`/`turn_end`, and `user.message`
    replay. `subtype` ← the event `type` (e.g. `"assistant.turn_start"`).
- **Everything unrecognised** → `CopilotUnknownEvent` (`copilotType` ←
  the event's `type`).

### sessionId

**`sessionId` appears ONLY in the terminal `result` event** — NOT at
init (contrast Claude/Codex, which surface it on the first event). So
`mapCopilotEvent` returns `sessionId: null` for every event until
`result`, then `sessionId = result.sessionId`. The participant should
capture it from `result` rather than expecting it early.

### ready / done resolution (for `CopilotCliParticipant`, later story)

- `ready`: resolve on the first recognised lifecycle event — the first
  line is reliably a `session.*` event. Fallback: first
  successfully-parsed JSON line.
- `done`: resolve from the process `exit`/`close` listener ONLY (observe
  the real exit code). The `result` event is the last *stream* line, but
  the authoritative completion signal is the process exit, mirroring the
  Codex comment.

### Story success predicate (for `copilot-story-agent.ts`, later story)

Use the **Codex predicate**: `success = exitCode === 0 && error == null`.
`copilot -p` exits nonzero on LLM error, so the exit code is meaningful.

The probe DID confirm a reliable terminal event (`result`, carrying
`exitCode`) and tool-call events (`tool.execution_start` /
`tool.execution_complete`, with `data.success`). So the OpenCode-style
tightening (`sawCompletion && toolCallCount > 0`) is *possible* — track
`sawResult` and `toolCallCount` in the participant summary if desired.
**Caveat:** a pure text answer (run 1) produced zero tool calls, so
`toolCallCount > 0` would wrongly fail text-only stories. Keep the Codex
predicate as the floor; only require tool calls if the story type
guarantees them.

## Noise / volume notes

- `assistant.message_delta` (ephemeral) is the highest-volume type
  (token deltas) — the non-streaming mapper ignores it. The 43-line run
  was ~40% deltas.
- `session.background_tasks_changed` fired 6× in the tool run — pure
  churn, route to `CopilotSystem` and let observers ignore it.
- A built-in `github-mcp-server` MCP server and a `report_intent` tool
  are auto-loaded; `report_intent` shows up as a tool call alongside the
  real `powershell` tool. The mapper treats them uniformly.

## Defaults observed

- Default model reported by `session.tools_updated` / `assistant.message`
  was `gpt-5.5` on this install (the design spec's documented default is
  `claude-sonnet-4.5`; the binary's own default may differ by version —
  pass `--model` explicitly when a specific model is required).
