# baro

## Background Agent Runtime Orchestrator

Give it a goal, it breaks it into stories, builds a dependency DAG, and runs them in parallel — each story gets its own AI agent.

![npm downloads](https://img.shields.io/npm/dt/baro-ai) ![npm downloads weekly](https://img.shields.io/npm/dw/baro-ai) ![npm version](https://img.shields.io/npm/v/baro-ai)

![baro screenshot](https://raw.githubusercontent.com/jigjoy-ai/baro/main/assets/screenshot.png)

> 📖 **Deep dive:** [Getting the Maximum Out of My Claude Code Subscription](https://jigjoy.ai/blog/getting-the-maximum-out-of-claude-code) — the story of why baro exists, how it pairs with Mozaik, and what it looks like in practice.

## What's new (0.22–0.23)

- **Opus as the default executor** — richer reasoning per story, still with routed Sonnet/Haiku available via `--model` or `.barorc`.
- **Smaller-stories planner** — the planner now biases toward narrower, more independent stories that parallelize better on the DAG.
- **Branch dedup** — reruns on the same goal reuse the existing `baro/<name>` branch instead of piling up duplicates.
- **TUI: terminal-clear on tab switch** — cleaner transitions between story logs, DAG view, and stats.
- **Audit log survives project resets** — JSONL event logs now live in `~/.baro/runs/` by default, so a wiped `node_modules` or a fresh clone doesn't lose history.
- **Always-on audit + abnormal-exit banner** — every run is recorded, and the TUI surfaces an explicit banner when the orchestrator exits unexpectedly.

## Install

```
npm install -g baro-ai
```

Requires [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated.

## Usage

```bash
# Interactive - opens welcome screen
baro

# Direct - skip to planning
baro "Add authentication with JWT and role-based access control"

# Use OpenAI for planning
baro --planner openai "Add WebSocket support"

# Limit parallelism to 3 concurrent stories
baro --parallel 3 "Refactor database layer"

# Set story timeout to 5 minutes
baro --timeout 300 "Add unit tests"

# Force a specific model for all phases
baro --model opus "Complex architecture redesign"

# Disable model routing (use opus everywhere)
baro --no-model-routing "Build entire app"

# Dry run - generate plan without executing
baro --dry-run "Add REST API"

# Resume interrupted execution (or execute a dry-run plan)
baro --resume

# Specify working directory
baro --cwd ~/projects/myapp "Add REST API"
```

## How it works

1. **Plan** — Claude (Opus) explores your codebase and generates a dependency graph of user stories
2. **Review** — You review the plan, refine with feedback, accept or quit
3. **Execute** — Stories run in parallel on a feature branch, each with its own Claude agent (Opus by default in 0.23+; Sonnet/Haiku available via `--model` or `.barorc`)
4. **Review Agent** — After each level, a review agent (Haiku) checks work against acceptance criteria and creates fix stories if needed
5. **Finalize** — Runs build verification and creates a GitHub PR with full summary

## Features

- **Parallel execution** — independent stories run simultaneously, respecting dependency order
- **DAG engine** — topological sort with level grouping, cycle detection
- **Model routing** — Opus for planning and execution (0.23+ default), Haiku for review (configurable)
- **Live TUI** — dashboard with story status, live agent logs, DAG view, stats
- **Review agent** — automated code review between levels with build detection and auto-fix
- **Plan refinement** — press `r` on review screen to give feedback and regenerate the plan
- **Build detection** — auto-detects project type (Cargo, npm, Go, Python, Make) and runs builds during review
- **Git coordination** — mutex-protected commits, auto-push with retry, pull --rebase, conflict detection
- **Branch per run** — creates `baro/<name>` branch, keeps main clean, reuses existing branches on rerun (0.23+)
- **Dry run** — `--dry-run` generates plan and saves to `prd.json` without executing, then `--resume` to run it
- **Resume** — detects `prd.json` and resumes incomplete executions
- **PR creation** — creates GitHub PR with stories table, stats, time saved, and review summary
- **Configurable parallelism** — `--parallel N` to limit concurrent story execution
- **Story timeout** — `--timeout SECONDS` kills stuck agents (default: 10 minutes, hard timeout disabled in 0.22+)
- **Time saved** — shows parallel speedup vs sequential execution
- **System notifications** — terminal bell + OS notification (macOS/Linux/Windows) when done
- **Retry logic** — failed stories retry automatically (configurable per story)
- **Interactive settings** — configure model, parallelism, timeout, context, and planner on the welcome screen with Tab/arrow keys
- **Project config** — `.barorc` file in project root sets defaults (no CLI flags needed)
- **Session lock** — prevents multiple baro instances from running in the same directory
- **Audit log** — every bus event written to `~/.baro/runs/<run-id>.jsonl`

## Config file

Create a `.barorc` in your project root to set defaults:

```json
{
  "model": "routed",
  "parallel": 3,
  "timeout": 600,
  "skipContext": false,
  "planner": "claude"
}
```

All fields are optional. CLI flags override `.barorc`, and interactive changes on the welcome screen override both.

| Field | Values | Default |
|-------|--------|---------|
| `model` | `"routed"`, `"opus"`, `"sonnet"`, `"haiku"` | `"routed"` |
| `parallel` | `0` (unlimited) or any number | `0` |
| `timeout` | seconds per story | `600` |
| `skipContext` | `true` / `false` | `false` |
| `planner` | `"claude"`, `"openai"` | `"claude"` |
| `dryRun` | `true` / `false` | `false` |

## Options

```
baro [goal] [options]

Arguments:
  goal                         Project goal (opens welcome screen if omitted)

Options:
  --planner <name>             Planner: claude or openai (default: claude)
  --model <name>               Override model for all phases: opus, sonnet, haiku
  --no-model-routing           Use opus for everything (disables routing)
  --parallel <N>               Max concurrent stories, 0 = unlimited (default: 0)
  --timeout <seconds>          Story timeout in seconds (default: 600)
  --dry-run                    Generate plan only, save to prd.json, do not execute
  --resume                     Resume from existing prd.json (also runs dry-run plans)
  --skip-context               Skip CLAUDE.md auto-generation
  --cwd <path>                 Working directory (default: current)
  --no-critic                  Disable live Critic (default: on). The Critic
                               reviews each agent turn against acceptance
                               criteria via `claude --model haiku` and injects
                               corrective feedback when the turn doesn't pass.
  --critic-model <name>        Model for the Critic (default: haiku)
  --no-librarian               Disable cross-agent runtime memory (default: on)
  --no-sentry                  Disable file-touch conflict detector (default: on)
  --no-surgeon                 Disable Surgeon (default: on). The Surgeon
                               observes terminal story failures and proposes
                               replans (split / prereq / rewire) so failed
                               work gets done in a different shape rather
                               than dropped.
  --no-surgeon-llm             Use deterministic Surgeon (skip-only) instead
                               of the LLM-driven replanner. The LLM Surgeon
                               is on by default; it costs an Opus call per
                               terminal failure but produces richer replans.
  --surgeon-model <name>       Model for the Surgeon LLM (default: opus)
  -h, --help                   Print help
```

### Phase 2/3/4 observers (Mozaik bus)

baro 0.19+ runs every story through a TypeScript Mozaik orchestrator.
Stories on the same DAG level run truly in parallel and observers can
react to one another's bus events:

- **Librarian** (default ON) — when one agent reads a file or runs grep,
  later agents in the run see the digest in their prompt and skip the
  redundant exploration. Measurable token savings on multi-story runs.
- **Sentry** (default ON) — flags overlapping Edit/Write tool calls
  across concurrent stories.
- **Critic** (default ON) — Haiku evaluator reviews each agent turn
  against acceptance criteria; on a fail verdict, an inline corrective
  message lands as the agent's next turn so it self-corrects before
  commit. Disable with `--no-critic`.
- **Surgeon** (default ON, with LLM) — when a story fails its retry
  budget, the Surgeon asks Opus for a richer replan and emits a
  ReplanItem the Conductor applies at the next level boundary. The LLM
  is biased toward keeping the work done — it prefers splitting a too-
  large story into smaller pieces, inserting a prerequisite, or
  rewiring dependencies, over dropping outright. A run is reported as
  successful only when every original story passes; if the Surgeon
  drops a story without replacement, the run terminates with a clear
  "did not complete the goal" verdict instead of a green tick. Disable
  the LLM with `--no-surgeon-llm` to fall back to deterministic
  skip-only behavior, or `--no-surgeon` to remove adaptive replans
  entirely.

## Requirements

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated
- macOS (arm64/x64), Linux (x64/arm64), or Windows (x64)
- **Node.js 20+** (orchestrator runtime)
- `gh` CLI (optional, for automatic PR creation)

> **Windows note:** Windows 10+ is required. For best TUI experience, use [Windows Terminal](https://aka.ms/terminal) or another modern terminal emulator.

## Architecture

Rust binary distributed via npm. TUI built with ratatui, async execution
with tokio. Each `baro` invocation spawns the bundled TypeScript
[Mozaik](https://github.com/jigjoy-ai/mozaik) orchestrator as a
subprocess; the orchestrator owns story execution and emits typed
events into a shared `AgenticEnvironment` bus. Each story is one
`claude` CLI subprocess (auth inherits from your Claude CLI session —
no API key needed).

The orchestrator is itself a Mozaik agentic environment: there is no
imperative `run()` method, no top-level `Promise.all` loop. The
**Conductor** is a state machine that reacts to typed bus events
(`RunStartRequest` → `LevelComputeRequest` → `StorySpawnRequest` →
`StoryResult` → `LevelCompleted` → …). Spawning a story, evaluating a
turn, and replanning the DAG are all reactions, not steps in a loop.

Ten participants share that bus:

| Participant     | Role                                                              |
| --------------- | ----------------------------------------------------------------- |
| `Conductor`     | Orchestration state machine — drives the run by reacting          |
| `StoryFactory`  | Spawns Story Agents on each `StorySpawnRequest`                   |
| `StoryAgent`    | Runs one story via Claude CLI, with retries and timeout           |
| `Librarian`     | Cross-agent memory — indexes outputs of exploration tools         |
| `Sentry`        | Flags overlapping file writes across concurrent stories           |
| `Critic`        | Per-turn acceptance-criteria evaluator (default ON, `--no-critic` to disable) |
| `Surgeon`       | Emits DAG replans when a story fails terminally (default ON, `--no-surgeon` to disable) |
| `Operator`      | Bridges external user commands (TUI, web UI) into bus events      |
| `Auditor`       | JSONL log of every event on the bus (written to `~/.baro/runs/`)  |
| `Cartographer`  | Translates bus events into UI frames for the Rust TUI             |

The bus is open. New participants — CI deployers, Slack notifiers,
external ticket triggers — are subscribers and emitters with no changes
to the orchestrator.

## Status & feedback

baro is a work in progress. I'm actively adding things, testing ideas,
and occasionally breaking them — if a run explodes, an [issue on
GitHub](https://github.com/jigjoy-ai/baro/issues) with the run's audit
log from `~/.baro/runs/` is the fastest way to get it fixed.

If you like the idea and want to help shape where it goes, PRs are
welcome, and you can DM me on Twitter
[@lotus_sbc](https://twitter.com/lotus_sbc) with ideas, use cases, or
bug reports.

## License

MIT

---

Made by [Lotus](https://github.com/Lotus015) from [JigJoy](https://jigjoy.ai) team
