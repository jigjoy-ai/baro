# baro-dsh

baro as a subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
A dsh agent delegates a goal, baro plans and executes it in the session's
working directory as a headless run, and the delegation comes back with the
certified outcome: whether the run succeeded, how it was classified when it
did not, and the pull request if one was made. While it runs it is a `baro-N`
job in dsh's jobs list, readable by anyone in the frame.

## Install

```sh
dsh plugin --profile web add baro-dsh
```

The `baro` CLI must be on `PATH` (`npm i -g baro-ai`) and logged into its own
model lane; dsh scrubs the parent environment, so any credential baro needs
goes into the plugin's `env` config, never inherited.

## Configuration

| key | default | meaning |
|---|---|---|
| `providerName` | `baro` | name under `ctx.subagents` |
| `command` | `baro` | executable, name on PATH or absolute path |
| `args` | `[]` | extra `baro` flags (e.g. `--llm codex`) |
| `localOnly` | `true` | `--local-only`: no baro-owned pushes or pull requests |
| `cwd` | parent session cwd | working directory override |
| `env` | `{}` | child environment (credentials go here) |
| `disposeGraceMs` | `5000` | SIGTERM→SIGKILL grace on dispose |

## Layout

- `src/domain` — baro's TUI protocol v3 and the run fold; no dsh imports.
- `src/application` — the one use case, `DelegateRun`, over two ports:
  a process to run and an observer to watch.
- `src/adapters/dsh` — dsh's subagent provider, subprocess and jobs seams.
- `src/index.ts` — the plugin: composition only.

Pinned to dsh `0.1.2-rc.1`; the provider seam is a developer preview upstream.
