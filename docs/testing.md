# Testing

The TypeScript packages run on [rstest](https://rstest.rs); the Rust crates on
`cargo test`. Nothing here calls a paid provider: backends are fakes and local
fixture processes.

## Orchestrator (`packages/baro-orchestrator`)

| Command | What it runs | Roughly |
| --- | --- | --- |
| `npm run test:fast` | `unit` project: in-memory tests | 30 s |
| `npm run test:slow` | `process` project: spawns CLIs, drives git worktrees, runs `orchestrate()` end to end | tens of minutes |
| `npm test` | `test:fast`, then `test:slow` | |
| `npm run test:changed` | tests related to what differs from `origin/main` | |
| `npm run test:related -- src/foo.ts` | tests that import the given source files | |
| `npm run test:watch` | `unit` in watch mode | |

One file or one test: `npx rstest run test/board.test.ts -t "name pattern"`.

The two projects are defined in `rstest.config.ts`. A new test file is a
`unit` test unless its path matches `PROCESS_TESTS` there; add a pattern when a
test starts real processes, so the fast lane stays fast.

The slow lane runs two workers: its tests are bound by process launches and
git, and more workers mostly stretch each test's timing. Useful flags:
`--pool.maxWorkers <n>` to override, `--shard 1/4` to split
a run, `-f` to rerun only what failed last time, `--reporter=verbose` for
per-test timings.

### Writing tests under rstest

- Import `describe`, `it`, `beforeAll`, `afterAll`, `rs` from `@rstest/core`;
  assertions stay on `node:assert/strict`.
- Source modules are bundled per test file. Assigning to a builtin
  (`childProcess.spawn = ...`) does not reach them; replace the module instead:
  `rs.mock("node:child_process", { spy: true })`, then
  `rs.mocked(spawn).mockImplementation(...)`.
- rstest refuses `process.kill` on the worker's own pid. A test that needs
  "some live process" uses `process.ppid`.
- Wait on a condition (`test/wait-for.ts`, `test/process-liveness.ts`), never
  on a sleep sized for an idle machine.
- `test/env.ts` is the setup file: it keeps tests away from the real
  `~/.baro` and from run-start cleanup of real worktree dirs.
- Tests are type-checked: `npm run typecheck` covers `src`, `test` and
  `scripts` through `tsconfig.test.json` (rstest itself strips types and would
  run a test that no longer matches the source). No `any` or `@ts-expect-error`
  to get past it; a deliberately invalid value gets one cast where it is built.

### What Baro runs as a gate here

When Baro works on this repository, its gates run a package's `build`,
`typecheck` and `test` scripts. `npm run test` here includes the slow lane, far
longer than a gate's ten-minute limit, so the orchestrator's `package.json`
names the script to use instead:

```json
"baro": { "verification": { "scripts": { "test": "test:fast" } } }
```

Any package can do the same for `build`, `typecheck`, `test` or `lint`. A name
that is not one of the package's scripts is ignored. The slow lane is CI's job.

## Other packages

`npm test -w baro-dsh` and `npm test -w @baro/memory` (the latter downloads
the ONNX embedding model on first run).

## Rust

`cargo test --workspace`. Give each git worktree of this repo its own
`CARGO_TARGET_DIR`: tests bake in `CARGO_MANIFEST_DIR`.

## CI

`.github/workflows/test.yml` runs on every pull request: typecheck (sources
and tests of all three packages) and the `unit` project on Linux, the `process` project in four shards on macOS, and
the Rust tests.
