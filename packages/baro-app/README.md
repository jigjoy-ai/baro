# baro

## Background Agent Runtime Orchestrator

Give it a goal, it breaks it into stories, builds a dependency DAG, and runs them in parallel — each story gets its own AI agent.

![npm downloads](https://img.shields.io/npm/dt/baro-ai) ![npm downloads weekly](https://img.shields.io/npm/dw/baro-ai) ![npm version](https://img.shields.io/npm/v/baro-ai)

![baro screenshot](https://raw.githubusercontent.com/jigjoy-ai/baro/main/assets/screenshot.png)

## Install

```
npm install -g baro-ai
```

Requires at least one of: [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) authenticated, [OpenAI Codex CLI](https://github.com/openai/codex) authenticated, or `OPENAI_API_KEY` exported.

## Usage

```bash
# Interactive - opens welcome screen
baro

# Direct - skip to planning (default uses Claude Code under the hood)
baro "Add authentication with JWT and role-based access control"

# Codex everywhere (ChatGPT Pro/Plus subscription)
baro --llm codex "Refactor the database layer"

# Per-phase routing — Claude upstream, Codex downstream
baro --llm hybrid "Add WebSocket support across api and frontend"

# Route every phase through GPT-5.5 via Mozaik-native OpenAI API
OPENAI_API_KEY=sk-... baro --llm openai "Refactor the database layer"

# Mix it yourself — any phase can run on any backend
baro --architect-llm claude --story-llm codex --critic-llm codex \
     "Complex refactor where you want Claude planning"

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

1. **Plan** — Architect + Planner agents explore your codebase and generate a dependency graph of user stories
2. **Review** — You review the plan, refine with feedback, accept or quit
3. **Execute** — Stories run as independently scheduled workers on a feature branch: CLI backends use subprocesses, while Mozaik-native OpenAI-compatible workers run in-process (picked by `--llm` or `--story-llm`)
4. **Critic** — After every turn, a Critic agent checks work against acceptance criteria and injects corrective feedback when verdict is FAIL
5. **Finalize** — Runs build verification and creates a GitHub PR with full summary

## Five LLM backends, one DAG

`--llm` picks how every agent in the run talks to its model:

- `--llm claude` (default) — every agent shells out to the Claude Code CLI in headless mode. Bills against your Claude Max subscription.
- `--llm codex` — every agent shells out to OpenAI's Codex CLI (`codex exec --json`). Bills against ChatGPT Pro/Plus subscription. ~3–11× cheaper per equivalent run than Claude.
- `--llm openai` — Mozaik-native OpenAI Responses API. Bills per token retail.
- `--llm opencode` — shells out to OpenCode (`opencode run --format json`), using the provider and model configured in OpenCode.
- `--llm pi` — shells out to Pi (`pi --mode json -p`), using the provider and model configured in Pi.
- `--llm hybrid` — Claude on Architect/Planner/Surgeon (where the upstream plan matters), Codex on Story/Critic (the parallel work that dominates the budget). Recommended for serious runs.

Per-phase overrides exist (`--architect-llm`, `--planner-llm`, `--story-llm`, `--critic-llm`, `--surgeon-llm`) if you want to mix anything yourself.

See [docs.baro.rs/llm-providers](https://docs.baro.rs/llm-providers) for the full provider breakdown, or the [side-by-side benchmark across three real tasks](https://jigjoy.ai/blog/claude-code-vs-codex-baro).

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
  --llm <name>                 Backend for every phase: claude | codex | openai |
                               opencode | pi | hybrid
                               (default: claude)
  --architect-llm <name>       Override LLM for Architect only
  --planner-llm <name>         Override LLM for Planner only
  --story-llm <name>           Override LLM for Story Agents only
  --critic-llm <name>          Override LLM for Critic only
  --surgeon-llm <name>         Override LLM for Surgeon only
  --model <name>               Override model for all phases: opus, sonnet, haiku
                               (or per-provider equivalents)
  --no-model-routing           Use opus for everything (disables routing)
  --parallel <N>               Max concurrent stories, 0 = unlimited (default: 0)
  --timeout <seconds>          Story timeout in seconds (default: 600)
  --coordination <mode>        legacy (default) | collective (experimental)
  --local-only                Disable Baro-owned pushes and PR creation
  --dry-run                    Generate plan only, save to prd.json, do not execute
  --resume                     Resume from existing prd.json (also runs dry-run plans)
  --skip-context               Skip CLAUDE.md / AGENTS.md auto-generation
  --cwd <path>                 Working directory (default: current)
  -h, --help                   Print help
```

## Requirements

- At least one of:
  - [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) authenticated (for `--llm claude`, the default)
  - [OpenAI Codex CLI](https://github.com/openai/codex) authenticated (for `--llm codex`)
  - [OpenCode CLI](https://opencode.ai) with a provider configured (for `--llm opencode`)
  - Pi CLI with a provider configured (for `--llm pi`)
  - `OPENAI_API_KEY` exported (for `--llm openai`)
  - Both Claude CLI **and** Codex CLI authenticated (for `--llm hybrid`)
- macOS (arm64/x64), Linux (x64/arm64), or Windows (x64)
- Node.js 20+
- `gh` CLI (optional, for automatic PR creation)

> **Windows note:** Windows 10+ is required. For best TUI experience, use [Windows Terminal](https://aka.ms/terminal) or another modern terminal emulator.

## Architecture

Rust binary distributed via npm. The TUI is built with ratatui and tokio. Before planning, a short-lived Mozaik lane lets the Conversation participant delegate repository research to an autonomous RepoScout. Scout starts from a deterministic snapshot, iteratively chooses only Baro-owned shell-free read/search/glob observations, excludes observed symlinks and known credential/key/cloud-state paths, and returns a bounded evidence brief or an explicitly truncated deterministic fallback. Scout and Conversation are separate provider-neutral roles even though the local CLI initially routes both through the selected backend/model. Their provider process is isolated in an empty temporary directory: Claude, OpenCode and Pi use explicit no-tool modes, while Codex uses a strict least-privilege profile that denies the empty workspace, tool network and inherited shell environment and ignores local config/rules. Every provider route then validates the candidate goal before acceptance. Claude, Codex and native OpenAI can inspect the checkout read-only; OpenCode and Pi use an isolated inference-only Architect with Baro's bounded brokered context. The pre-acceptance Codex Architect can explore the checkout from its read-only working root, while strict CLI config disables automatic repository `AGENTS.md`/project-document injection so those files are evidence rather than trusted instructions. The repository-scoped pre-PRD transcript survives restart, while interrupted provider turns are closed before retry. During execution, Board/Conductor, worker factories and observers share a separate [Mozaik](https://github.com/jigjoy-ai/mozaik) event bus; CLI workers are bridged from subprocesses, while native OpenAI-compatible workers run in-process. The current Conductor remains the default; `--coordination collective --local-only` enables the experimental claim/lease/integration engine while disabling Baro-owned pushes and PR creation. Use a remote-free disposable immutable clone when hard filesystem isolation is required, because story agents can execute shell commands and concurrent checkout mutation can race path checks.

## License

MIT

---

Made by [Lotus](https://github.com/Lotus015) from [JigJoy](https://jigjoy.ai) team
