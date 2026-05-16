# baro

## Background Agent Runtime Orchestrator

Give it a goal, it breaks it into stories, builds a dependency DAG, and runs them in parallel — each story gets its own AI agent.

![npm downloads](https://img.shields.io/npm/dt/baro-ai) ![npm downloads weekly](https://img.shields.io/npm/dw/baro-ai) ![npm version](https://img.shields.io/npm/v/baro-ai)

![baro screenshot](https://raw.githubusercontent.com/jigjoy-ai/baro/main/assets/screenshot.png)

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
3. **Execute** — Stories run in parallel on a feature branch, each with its own Claude agent (Sonnet)
4. **Review Agent** — After each level, a review agent (Haiku) checks work against acceptance criteria and creates fix stories if needed
5. **Finalize** — Runs build verification and creates a GitHub PR with full summary

## Features

- **Parallel execution** — independent stories run simultaneously, respecting dependency order
- **DAG engine** — topological sort with level grouping, cycle detection
- **Model routing** — Opus for planning, Sonnet for execution, Haiku for review (configurable)
- **Live TUI** — dashboard with story status, live agent logs, DAG view, stats
- **Review agent** — automated code review between levels with build detection and auto-fix
- **Plan refinement** — press `r` on review screen to give feedback and regenerate the plan
- **Build detection** — auto-detects project type (Cargo, npm, Go, Python, Make) and runs builds during review
- **Git coordination** — mutex-protected commits, auto-push with retry, pull --rebase, conflict detection
- **Branch per run** — creates `baro/<name>` branch, keeps main clean
- **Dry run** — `--dry-run` generates plan and saves to `prd.json` without executing, then `--resume` to run it
- **Resume** — detects `prd.json` and resumes incomplete executions
- **PR creation** — creates GitHub PR with stories table, stats, time saved, and review summary
- **Configurable parallelism** — `--parallel N` to limit concurrent story execution
- **Story timeout** — `--timeout SECONDS` kills stuck agents (default: 10 minutes)
- **Time saved** — shows parallel speedup vs sequential execution
- **System notifications** — terminal bell + OS notification (macOS/Linux/Windows) when done
- **Retry logic** — failed stories retry automatically (configurable per story)
- **Interactive settings** — configure model, parallelism, timeout, context, and planner on the welcome screen with Tab/arrow keys
- **Project config** — `.barorc` file in project root sets defaults (no CLI flags needed)
- **Session lock** — prevents multiple baro instances from running in the same directory

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
  -h, --help                   Print help
```

## Requirements

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated
- macOS (arm64/x64), Linux (x64/arm64), or Windows (x64)
- Node.js 18+ (only if using `--planner openai`)
- `gh` CLI (optional, for automatic PR creation)

> **Windows note:** Windows 10+ is required. For best TUI experience, use [Windows Terminal](https://aka.ms/terminal) or another modern terminal emulator.

## Architecture

Rust binary distributed via npm. TUI built with ratatui, async execution with tokio, one Claude CLI process per story.

## License

MIT

---

Made by [Lotus](https://github.com/Lotus015) from [JigJoy](https://jigjoy.ai) team
