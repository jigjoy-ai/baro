# ADR-0001: Add one ~/.baro path helper in TS and one in Rust, used only by new code

**Status:** Accepted
**Context:** Several items (#140, #149, #152, #162) write under ~/.baro, and each call site today builds the path itself. Tests need to redirect it away from the real home directory. Rewriting the existing call sites would be an unrelated refactor.
**Decision:** TS: new file packages/baro-orchestrator/src/runtime/baro-home.ts exports `baroHome(): string`. It returns process.env.BARO_HOME when non-empty, else join(homedir(), ".baro").
Rust: new file crates/baro-tui/src/baro_home.rs, declared as `mod baro_home;` in main.rs, exports `pub fn baro_home() -> PathBuf`. It returns BARO_HOME if set and non-empty, else HOME/.baro, else USERPROFILE/.baro.
All new code in this run uses these helpers. Existing call sites are NOT migrated.
**Consequences:** Tests set BARO_HOME to a temp dir and never touch the real ~/.baro. Whichever story first needs a helper creates it. Later stories reuse the same file and must not duplicate it.
