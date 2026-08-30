# baro

> Type a goal in your repo. Walk away. Come back to a verified pull request.

[![npm version](https://img.shields.io/npm/v/baro-ai.svg?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/baro-ai)
[![npm downloads](https://img.shields.io/npm/d18m/baro-ai.svg?label=downloads)](https://www.npmjs.com/package/baro-ai)

baro is an autonomous software factory. It compiles your goal into a machine-checkable
contract, splits it into a DAG of stories, builds them in parallel across isolated git
worktrees, and blocks every merge behind fail-closed gates — declared tests, build,
an evidence critic, write-surface ownership. You review a PR the gates already accepted.

One prompt → a 33-story plan → 808 passing tests → a PR, in 71 minutes.
[See a real run.](https://jigjoy.ai/blog/baro-808-nestjs-jest-tests)

## Install

```bash
npm install -g baro-ai
```

Needs Node 20+, git, and at least one backend: the `claude` CLI (default), `codex`,
or any OpenAI-compatible endpoint. `baro --doctor` checks your setup.

## Use

```bash
cd your-repo
baro "Add JWT authentication with role-based access control"
```

That opens the TUI: intake asks only what matters, you confirm the plan, the fleet runs.

For automation, detach and follow from anywhere:

```bash
baro --headless --detach --goal-file goal.txt   # prints a run id, returns immediately
baro watch <run-id>                             # follow milestone events
baro logs <run-id> --follow                     # tail the raw log
baro runs                                       # list live runs
baro stop <run-id>                              # stop one
```

## Commands

| Command | What it does |
|---|---|
| `baro "<goal>"` | run a goal in the current repo (TUI) |
| `baro --goal-file <path>` | read the goal from a file |
| `baro --headless --detach ...` | background run for CI/automation; prints the run id |
| `baro watch <run-id>` | follow a live run's milestones |
| `baro logs <run-id> [--follow]` | print or tail a run's log |
| `baro runs` / `baro stop <id>` | list / stop live runs |
| `baro --resume` | resume an interrupted run from `prd.json` — **never re-plans** |
| `baro --continue` | follow-up on the current branch — **always re-plans** |
| `baro --doctor` | self-diagnostic: backends, auth, gh, permissions |
| `baro login` | browser sign-in for baro cloud |
| `baro connect [--install-service]` | attach this machine as a cloud runner |

## The flags that matter

```bash
--llm claude|codex|openai|opencode|pi|hybrid|jigjoy   # backend for all phases
-m opus|sonnet|haiku          # model override (verbatim pass-through on other backends)
--effort low..max             # thinking per turn (default: high)
--parallel N                  # max parallel story agents (0 = unlimited)
--mode focused|sequential|parallel   # force an execution mode (default: intake proposes)
--quick                       # trivial goals: one story, no architect/critic/surgeon
--local-only                  # no pushes, no PRs — hard isolation
--shell-budget <seconds>      # per-command budget for story shell tools
--openai-base-url <url>       # any OpenAI-compatible provider (OpenRouter, vLLM, Ollama…)
--tier-map "light=openai:MiniMax-M3,heavy=claude:opus"   # mix backends per story tier
```

Per-phase overrides (`--architect-llm`, `--story-model`, …), `.barorc`, and everything
else: [**docs.baro.rs**](https://docs.baro.rs)

## How it works

![baro architecture — a Rust TUI host, a TypeScript orchestrator whose bounded contexts meet on the mozaik event bus, and machine gates in front of every merge](https://raw.githubusercontent.com/jigjoy-ai/baro/main/assets/architecture.png)

- **Contract first.** An architect turns the goal into invariants and obligations that
  are machine-checkable — before any code is written.
- **A collective, not a coordinator.** Story agents are peers on an event bus: they see
  the events that concern them, exchange notes, and suspend/resume on each other's work.
  There is no single context window everything must squeeze through.
- **Gates, not vibes.** Declared tests, build-before-commit, an evidence critic that
  judges captured command output, and write-surface ownership — fail-closed, blocking
  every merge. The human reviews a PR the gates already accepted.
- **A live plan.** The plan is a DAG the run negotiates with: runtime replanning adds and
  rewires stories mid-run, and a failed gate can spawn its own remediation story.

## Drive it with Claude Code

baro pairs well with a coding agent in the driver's seat. Paste this into Claude Code
inside your repo:

```text
Install baro (npm install -g baro-ai) and run `baro --doctor` to verify the setup.
Then drive it for me:

1. Write my task as an evidence-rich goal file: name the exact files and line numbers
   the change touches, state the constraints, and say which tests must prove it.
2. Launch it detached: `baro --headless --detach --goal-file goal.txt`, note the run id.
3. Follow it with `baro watch <run-id>`; if it stalls, read `baro logs <run-id>`.
4. When the pull request opens, review the diff against the goal, run the project's
   test suite yourself, and report back: what shipped, what the gates proved, and
   anything that needs my eyes. Merge only if everything is green.

Keep goals narrow — one concern per run. If the run fails, read why, tighten the goal
with the new evidence, and launch again.
```

## Cloud

No machine, or no Claude/Codex subscription? Run the same fleet on
[**app.baro.jigjoy.ai**](https://app.baro.jigjoy.ai) — nothing to install, isolated
sandboxes, our keys. Or keep your own hardware in the pool: `baro login`, then
`baro connect --install-service`.

---

Docs: [docs.baro.rs](https://docs.baro.rs) · Issues: [github.com/jigjoy-ai/baro/issues](https://github.com/jigjoy-ai/baro/issues) · Twitter: [@lotus_sbc](https://twitter.com/lotus_sbc)
