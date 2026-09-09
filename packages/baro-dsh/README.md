# baro-dsh

baro as a subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
A dsh agent calls the `baro` tool with a goal; baro plans it into stories,
executes them in parallel with coding agents in the session's working
directory, reviews each story independently and verifies the merged result.
The delegation returns the certified outcome: whether the run succeeded, how it
was classified when it did not, the story count, commits, and the pull request
if one was made. While it runs, the sidebar shows a **baro runs** panel with the
phase (intake → architect → planning → executing → finalizing), story progress,
the agent's latest activity and the milestone log; dsh's own jobs list carries
it as a `baro-N` job.

## Install

```sh
dsh plugin --profile web add baro-dsh
```

The `baro` CLI must be on `PATH` (`npm i -g baro-ai`) and signed into its own
model lane. dsh scrubs the parent environment before spawning, so any credential
baro needs goes into the plugin's `env` config, never inherited.

## Configuration

| key | default | meaning |
|---|---|---|
| `providerName` | `baro` | name under `ctx.subagents`; the tool is named the same |
| `command` | `baro` | executable, name on PATH or absolute path |
| `args` | `[]` | extra `baro` flags (e.g. `--llm codex`) |
| `localOnly` | `true` | `--local-only`: no baro-owned pushes or pull requests |
| `cwd` | parent session cwd | working directory override |
| `env` | `{}` | child environment (credentials go here) |
| `disposeGraceMs` | `5000` | SIGTERM→SIGKILL grace on dispose |

## What the model sees

dsh's delegation tool has a fixed description, so the plugin adds a system
prompt section: `baro` is for goals that span several files or need more than
one coherent change; a single small edit or an investigation stays with the
agent or the ordinary subagent. A run takes 10–30 minutes.

## Outcome mapping

| baro `done` | dsh `stopReason` |
|---|---|
| `success: true` | `completed` |
| every story merged, verification passed, no abort code, goal contract left open | `completed` (the open contract is in the text) |
| `abort_code: token_ceiling` | `max-tokens` |
| cancelled or disposed | `aborted` |
| anything else | `error` |

The full protocol stream of a run is in `~/.baro/runs/<repo>-<timestamp>.jsonl`.

## Layout

- `src/domain` — baro's TUI protocol v3 and the run fold (phase, activity,
  milestones, outcome); no dsh imports.
- `src/application` — the one use case, `DelegateRun`, over two ports: a
  process to run and observers to watch, composed and isolated from each other.
- `src/adapters/dsh` — the subagent provider, the subprocess runner, the jobs
  observer and the settings observer that feeds the panel.
- `src/client` — the browser half: reads run state from the `baro-dsh` settings
  namespace, follows `settings/document-updated`, renders the sidebar panel.
- `src/index.ts` — the plugin: composition only.

## Why a settings namespace

An out-of-tree plugin cannot add a remote or a forwarded event to dsh's API
assembly (it is fixed at dsh build time). The settings service is writable from
the host, readable from every client, and its update event is forwarded, so
run state travels that way. Writes are throttled to one per second per run and
finished runs are pruned after five.

Pinned to dsh `0.1.2-rc.1`; the provider seam is a developer preview upstream.
