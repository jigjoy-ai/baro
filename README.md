# baro

## Background Agent Runtime Orchestrator

Give it a goal, it breaks it into stories, builds a dependency DAG, and runs them in parallel — each story gets its own AI agent.

![npm downloads](https://img.shields.io/npm/dt/baro-ai) ![npm downloads weekly](https://img.shields.io/npm/dw/baro-ai) ![npm version](https://img.shields.io/npm/v/baro-ai)

![baro screenshot](https://raw.githubusercontent.com/jigjoy-ai/baro/main/assets/screenshot.png)

> 📖 **Deep dive:** [Getting the Maximum Out of My Claude Code Subscription](https://jigjoy.ai/blog/getting-the-maximum-out-of-claude-code) — the story of why baro exists, how it pairs with Mozaik, and what it looks like in practice.

> 📊 **Recent post:** [How baro generated 808 NestJS Jest tests autonomously in 71 minutes](https://jigjoy.ai/blog/baro-808-nestjs-jest-tests) — one prompt, 33-story DAG, two sessions because of the Anthropic usage cap, 83.5% branch coverage, zero filed bug issues.

## What's new in 0.39

- **`--share-architect-cache` (experimental)** — routes the Architect's DecisionDocument through Claude Code's `--append-system-prompt` instead of prepending it to each story's user prompt. Anthropic's prompt cache hashes system + tools as the cache key, so with the flag on stories 2..N read the DD from cache at the 10× discount instead of each re-paying its own `cache_creation`. Default OFF; measure with audit-log token totals before flipping.

## What's new in 0.30–0.38 (the bigger shifts)

- **Dual-mode LLM**: `--llm openai` is fully end-to-end now (Architect / Planner / StoryAgent / Critic / Surgeon all route through Mozaik's native OpenAI runner). Defaults: gpt-5.5 for code-shaped phases, gpt-5.4-mini for Critic.
- **Architect phase**: an upstream agent that fixes cross-cutting design decisions (column names, file paths, API shapes, library choices) **before** any Story Agent starts, so 30 parallel agents don't each invent their own. See [baro vs Claude Code post](https://jigjoy.ai/blog/baro-vs-claude-code) for the architecture.
- **`--quick`** — skip Architect, force 1-story plan, silence Critic + Surgeon. For trivial goals (`baro --quick "fix the typo on line 42"`) where the design-doc + multi-agent ceremony is overhead.
- **Per-phase model overrides**: `--architect-model`, `--planner-model`, `--story-model`, `--critic-model`, `--surgeon-model` — pin any individual role to a specific model without forcing the rest with the global `--model`.
- **Branch per run**: every fresh run creates a new suffixed `baro/<slug>-<id>` branch, never falls back to checkout. Side-by-side runs from sibling clones can't collide on `git push`.
- **`baro --doctor`** — pre-flight self-check that verifies the `claude` CLI is on PATH and authenticated, the audit dir is writable, and `gh` exists. First thing to run when a baro run fails before any agents start.
- **Repo moved** to [jigjoy-ai/baro](https://github.com/jigjoy-ai/baro). npm package name unchanged (`baro-ai`).
- **gpt-5.5 defaults** + UTF-8 panic fix + Ghostty/kitty-keyboard Enter handling + Execute-screen 0/N resume fix (0.38.x).

## Install

```
npm install -g baro-ai
```

Requires [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated for `--llm claude` (the default). For `--llm openai`, set `OPENAI_API_KEY` in your shell env or enter it on the welcome screen.

## Usage

```bash
# Interactive — opens the welcome screen
baro

# Direct — skip to planning
baro "Add authentication with JWT and role-based access control"

# Route every phase through GPT-5.5 (Mozaik-native OpenAI runner)
OPENAI_API_KEY=sk-... baro --llm openai "Refactor the database layer"

# Limit parallelism to 3 concurrent stories
baro --parallel 3 "Refactor database layer"

# Set per-story timeout (default: 600s)
baro --timeout 300 "Add unit tests"

# Force one model everywhere — wins over per-phase routing
baro --model opus "Complex architecture redesign"

# Pin a single phase to a specific model
baro --story-model sonnet "Add WebSocket support"

# Dry-run — generate plan, save to prd.json, don't execute
baro --dry-run "Add REST API"

# Resume an interrupted run (also runs dry-run plans)
baro --resume

# Quick fast-path — skip Architect + Critic + Surgeon, single-story plan
baro --quick "fix the typo on line 42"

# EXPERIMENTAL — push Architect's DecisionDocument through Claude Code's
# cached system-prompt prefix so stories 2..N hit cache for the DD
baro --share-architect-cache "Add comprehensive test coverage"

# Specify working directory
baro --cwd ~/projects/myapp "Add REST API"

# Self-diagnostic and exit
baro --doctor
```

## How it works

1. **Architect** (Opus by default, or gpt-5.5 with `--llm openai`) — reads the codebase and writes a `DecisionDocument`: the file paths, names, schemas, API shapes, and library choices every story will use.
2. **Planner** — decomposes the goal into a dependency DAG of stories, with the DecisionDocument pinned.
3. **Review** — you accept the plan, or press `r` to refine it with feedback.
4. **Execute** — stories run in parallel on a fresh `baro/<slug>-<id>` branch. Each story is one Claude Code subprocess (or one Mozaik-native OpenAI session).
5. **Critic** (per-turn) — Haiku evaluator scores each agent turn against its acceptance criteria. On a fail verdict, an inline corrective lands as the agent's next turn so it self-corrects before the next tool call.
6. **Sentry + Librarian** (run-wide) — Sentry flags overlapping Edit/Write tool calls; Librarian indexes one agent's Read/Grep so the next agent doesn't redo the exploration.
7. **Surgeon** (on terminal failure) — asks Opus for a richer replan (split / prereq / rewire) instead of dropping a failed story outright.
8. **Finalize** — runs the project's build verification and opens a GitHub PR with stories table, stats, time saved, and a summary of every story's commits.

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
  goal                          Project goal (opens welcome screen if omitted)

Provider:
  --llm <name>                  Provider for every phase: claude (default) or openai.
                                openai routes through Mozaik's native OpenAI runner
                                (gpt-5.x); requires OPENAI_API_KEY.

Model selection:
  --model <name>                Override ALL phases: opus, sonnet, haiku
  --no-model-routing            Equivalent to --model opus
  --architect-model <name>      Pin only the Architect phase
  --planner-model <name>        Pin only the Planner phase
  --story-model <name>          Pin every Story Agent in the run
  --critic-model <name>         Model for the Critic (default: haiku)
  --surgeon-model <name>        Model for the Surgeon LLM (default: opus)

Run shape:
  --parallel <N>                Max concurrent stories per level (0 = unlimited)
  --timeout <seconds>           Per-story timeout (default: 600)
  --intra-level-delay <secs>    Stagger story spawns within a level so Librarian
                                can broadcast first agent's findings (default: 10)
  --quick                       Trivial-goal fast path — skip Architect, force
                                1-story plan, disable Critic + Surgeon
  --dry-run                     Generate plan only, save to prd.json
  --resume                      Resume from existing prd.json
  --share-architect-cache       EXPERIMENTAL — route DecisionDocument through
                                Claude Code's --append-system-prompt so stories
                                2..N read it from the prompt cache
  --skip-context                Skip CLAUDE.md auto-generation
  --cwd <path>                  Working directory (default: current)

Observers:
  --no-critic                   Disable live Critic (default: ON)
  --no-librarian                Disable cross-agent runtime memory (default: ON)
  --no-sentry                   Disable file-touch conflict detector (default: ON)
  --no-surgeon                  Disable Surgeon (default: ON)
  --no-surgeon-llm              Use deterministic Surgeon (skip-only) instead
                                of the LLM-driven replanner

Diagnostics:
  --doctor                      Run self-diagnostic and exit
  -h, --help                    Print help
```

### The participants (Mozaik bus)

Every story runs through a TypeScript Mozaik orchestrator. The orchestrator is itself a Mozaik agentic environment: there is no imperative `run()` method, no top-level `Promise.all` loop. The `Conductor` is a state machine that reacts to typed bus events. Spawning a story, evaluating a turn, replanning the DAG — all reactions on the bus, not steps in a loop.

| Participant     | Role                                                              |
| --------------- | ----------------------------------------------------------------- |
| `Architect`     | One Opus (or gpt-5.5) turn before planning — emits a `DecisionDocumentItem` that pins every cross-cutting design decision |
| `Planner`       | Decomposes the goal into a story DAG, with the DecisionDocument pinned |
| `Conductor`     | Orchestration state machine — drives the run by reacting          |
| `StoryFactory`  | Spawns Story Agents on each `StorySpawnRequest`                   |
| `StoryAgent`    | Runs one story via Claude CLI subprocess (or Mozaik OpenAI session) |
| `Librarian`     | Cross-agent memory — indexes outputs of exploration tools         |
| `Sentry`        | Flags overlapping file writes across concurrent stories           |
| `Critic`        | Per-turn acceptance-criteria evaluator (default ON, `--no-critic` to disable) |
| `Surgeon`       | Emits DAG replans when a story fails terminally (default ON, `--no-surgeon` to disable) |
| `Finalizer`     | Runs build verification, opens the GitHub PR with stories table + stats |
| `Operator`      | Bridges external user commands (TUI, web UI) into bus events      |
| `Auditor`       | JSONL log of every event on the bus (written to `~/.baro/runs/`)  |
| `Cartographer`  | Translates bus events into UI frames for the Rust TUI             |

The bus is open. New participants — CI deployers, Slack notifiers, external ticket triggers — are subscribers and emitters with no changes to the orchestrator. (Adding the Architect was a 200-line change because of this shape; see the [Mozaik post](https://jigjoy.ai/blog/baro-vs-claude-code).)

## Requirements

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated (for `--llm claude`, the default), OR `OPENAI_API_KEY` set (for `--llm openai`)
- macOS (arm64/x64), Linux (x64/arm64), or Windows (x64)
- **Node.js 20+** (orchestrator runtime)
- `gh` CLI (optional, for automatic PR creation)

> **Windows note:** Windows 10+ is required. For best TUI experience, use [Windows Terminal](https://aka.ms/terminal) or another modern terminal emulator.

## Architecture

Rust binary distributed via npm. TUI built with ratatui, async execution with tokio. Each `baro` invocation spawns the bundled TypeScript [Mozaik](https://github.com/jigjoy-ai/mozaik) orchestrator as a subprocess; the orchestrator owns story execution and emits typed events into a shared `AgenticEnvironment` bus.

## Status & feedback

baro is a work in progress. I'm actively adding things, testing ideas, and occasionally breaking them — if a run explodes, an [issue on GitHub](https://github.com/jigjoy-ai/baro/issues) with the run's audit log from `~/.baro/runs/` is the fastest way to get it fixed.

If you like the idea and want to help shape where it goes, PRs are welcome, you can DM me on Twitter [@lotus_sbc](https://twitter.com/lotus_sbc), or jump into the [JigJoy Discord](https://discord.gg/dvxY9J2kWX) where the people building baro and Mozaik hang out.

## License

MIT

---

Made by [Lotus](https://github.com/Lotus015) from [JigJoy](https://jigjoy.ai) team
