# ADR-0005: Resolve CARGO_TARGET_DIR in a new src/verification/cargo-env.ts and pass it only to cargo commands

**Status:** Accepted
**Context:** runCmd passes no `env` at all (verify.ts:1202-1209), so cargo in __run builds into __run/target from scratch. There is no TS ~/.baro helper and no TS repo-identity helper (only Rust, conversation_host.rs:29-41), so both must be created; putting them in verify.ts would bury them in a 1300-line file.
**Decision:** Create packages/baro-orchestrator/src/verification/cargo-env.ts exporting:

```ts
export function resolveCargoTargetDir(hostRoot: string, env?: NodeJS.ProcessEnv): string;
export function cargoEnvFor(hostRoot: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
```

- `resolveCargoTargetDir`: if `env.CARGO_TARGET_DIR` is a non-empty string, return it unchanged. Else if `existsSync(join(hostRoot, "target"))`, return `join(hostRoot, "target")`. Else return `join(homedir(), ".baro", "cargo-target", repositoryCacheKey(hostRoot))`, creating it with `mkdirSync(..., { recursive: true })`.
- `repositoryCacheKey(hostRoot)` is a non-exported local: `${basename(canonical).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40)}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}` where `canonical` is `realpathSync.native(hostRoot)` falling back to `resolve(hostRoot)` on throw. Do NOT reimplement the Rust FNV-1a key.
- `cargoEnvFor` returns `{ ...(env ?? process.env), CARGO_TARGET_DIR: resolveCargoTargetDir(hostRoot, env) }`.

In verify.ts `runCmd`, add `...(c.tool === "cargo" ? { env: cargoEnvFor(hostRepoRoot) } : {})` to the execFileCli options at verify.ts:1202-1209. Pass `env` for cargo only — npm and every other tool keep inheriting process.env implicitly (execFileCli replaces rather than merges, exec-file-cli.ts:142).
**Consequences:** `~/.baro/cargo-target/<name>-<hash16>` is a new directory under a home tree that packages/baro-memory whitelists by parent name; it grows unbounded and no cleanup is added in this run. A user-set CARGO_TARGET_DIR always wins. crates/baro-tui is not touched: it spawns no cargo and only forwards `--cwd`.
