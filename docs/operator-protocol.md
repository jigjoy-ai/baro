# Operator protocol

`operator.mjs --protocol json` is the operator with its surface removed: one
JSON object per line on stdout, one per line on stdin. The Rust TUI speaks it;
`--protocol terminal` (the default) is the same session drawn as a plain chat.

Every event carries `ts` (ISO 8601).

## Events (stdout)

| type | fields | meaning |
|---|---|---|
| `ready` | | the operator accepts commands |
| `note` | `text` | one dim line: banner, milestone, queue note, refusal |
| `assistant_delta` | `text` | a slice of the reply, in order; the turn ends with `turn_done` |
| `tool_call` | `name`, `summary` | the operator invoked a tool; `name` is `baro delegate` etc. for its own tools |
| `tool_result` | `summary` | first meaningful line of what the last tool returned, with `(+N lines)` when there was more |
| `ask` | `id`, `kind` (`permission` \| `quit`), `prompt`, `tool?`, `summary?`, `options` | a question only the person can answer; answer with `answer` |
| `turn_done` | `duration_ms`, `cost_usd` (nullable) | the reply is complete |
| `runs` | `runs[]`: `id`, `state`, `phase`, `completed`, `total`, `goal`, `elapsed`, `started_ms?`, `finished_ms?`, `pr_url?`, `activity?`, `stories[]` (`id`, `title`, `status`), `milestones[]` (last 20), `activity_tail[]` (last 40 live-feed lines with a clock, phase changes included), `error?` | snapshot after anything about a run changed, at most once a second for activity; a surface with a clock derives elapsed from `started_ms` between snapshots |
| `exit` | | the operator is shutting down |

`state` is `queued`, `running`, `completed`, `error`, `max-tokens` or `aborted`.
`phase` follows the run tracker: `intake`, `architect`, `planning`, `executing`,
`finalizing`, `done`, or `queued`.

## Commands (stdin)

| type | fields | meaning |
|---|---|---|
| `user` | `text` | a message from the person; the operator replies with deltas |
| `answer` | `id`, `answer` | reply to an `ask`; permission answers are `y`, `n` or `a` (always for that tool) |
| `runs` | | print the run table as a `note` |
| `status` | `id` | print one run's status as a `note` |
| `stop` | `id` | stop a running or queued run |
| `quit` | `stop_runs` (bool) | shut down; when omitted the operator asks with `ask` kind `quit` |

Closing stdin is a `quit` that leaves runs running.

## Guarantees

- One `ask` is outstanding at a time; the operator serializes them.
- `assistant_delta` never interleaves with another turn's deltas; `turn_done`
  separates turns.
- A finished run is reported twice: as a `note` and, through the model, as a
  normal reply that starts after a `[baro] run-N finished` message.
