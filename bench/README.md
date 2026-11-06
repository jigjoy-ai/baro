# Baro benchmark

Five fixed goals on fixed repositories, run headless with Sonnet in every role,
measured only from Baro's event stream. Run it before a release and compare with
the previous release's summary.

```bash
# Baseline: a published release
node bench/run.mjs --label v0.122.1 --baro "npx --yes baro-ai@0.122.1"

# Candidate: a local build
node bench/run.mjs --label local --baro ~/.baro/local-v4/baro

# One case only
node bench/run.mjs --label local --baro ~/.baro/local-v4/baro --only bugfix

# Multi-story cases vary run to run: repeat and compare medians
node bench/run.mjs --label local --baro ~/.baro/local-v4/baro --only shared-file --repeat 3

# Record every child process (git, model CLIs, installs, tests) with its duration
node bench/run.mjs --label local --baro ~/.baro/local-v4/baro --only single-route --trace
node bench/profile/summarize.mjs bench/results/local/single-route.trace.jsonl

# Exits 1 on a regression (a case that passed now fails, or wall time or cost +15%)
node bench/compare.mjs bench/results/v0.122.1/summary.json bench/results/local/summary.json
```

Cases run one at a time, so their timings do not skew each other; the full suite
takes about 30–40 minutes and a few dollars. Each case gets a fresh git
repository under `$TMPDIR/baro-bench/<label>/<case>`.

| Case | Shape |
|---|---|
| `single-route` | one small change in one file |
| `bugfix` | find and fix bugs that failing tests expose |
| `parallel-py-js` | two independent stacks, then a joining doc story |
| `three-modules` | three independent modules, then a joining doc story |
| `shared-file` | two features that both edit `server.mjs` |

## What is measured (`metrics.mjs`)

- `wall_secs`: process start to exit. `to_first_story_secs`: start to the first
  `story_start`, which is the planning cost a user waits through.
- `stories_secs`: first `story_start` to last `story_merged`.
  `finalize_secs`: last merge to `done`.
- `cost_usd` and `tokens`, from `model_usage`, with `phases` broken down by role
  (architect, planner, story, critic, …) and `cache_hit_ratio`.
- `retries`, `replans`, and `critic_reviews` from `turn_review`: rejections and
  re-runs forced by stale evidence. Builds before `turn_review` report `null`.
- Per story: duration, attempts, critic reviews and cost.

`results/<label>/summary.json` is committed as the baseline. The raw streams
(`*.jsonl`) and stderr stay local.
