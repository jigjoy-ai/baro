# ADR-0005: Delete the registry record in `run_stop` once the process is confirmed dead

**Status:** Accepted
**Context:** `stop(&record)` (run_registry.rs:237-249) returns liveness after TERM→KILL but never removes `~/.baro/live/run-<pid>.json`; removal relies on `RunHandle::drop` (:100-106), which a detached run never performs (`remove_on_drop: false`, :167) and which an early TERM during startup can skip entirely. `live_runs` (:199-209) already reaps and filters dead pids, so `baro runs` is correct today. Alternative rejected: removing inside `stop()` — `stop` is a pure signal/poll helper used for its boolean and should not own filesystem state.
**Decision:** In crates/baro-tui/src/cli/run_registry.rs only:
1. Add `fn remove_record(dir: &PathBuf, id: &str) -> bool` next to `reap_dead` (~:170), returning `fs::remove_file(dir.join(format!("{id}.json"))).is_ok()`. Keep it private (crate-internal, file-local like `reap_dead`/`read_all`) and take an explicit `dir` — never call `registry_dir()` inside it — so it is testable under a temp home.
2. In `run_stop` (:271-293), after `stop(&record)` returns `true` and before the success print at :284-286, call `let _ = remove_record(&registry_dir(), &record.id);` followed by `reap_dead(&registry_dir());`. Removal failure must never turn a successful stop into an error.
3. When `stop` returns `false` (process still alive) do NOT remove the record; keep the existing `io::Error::other` failure path (:288-292) unchanged.
4. Leave `live_runs`, `reap_dead`, `read_all`, `find`, `print_runs`, `stop`, `signal_target`, `is_process_alive`, `RunRecord`, `RunHandle`, `register`, and `register_detached` behaviourally unchanged; `baro runs` culling is verified by test, not rewritten.
5. Do not modify crates/baro-tui/src/main.rs or crates/baro-tui/src/cli/detach.rs for this decision.
**Consequences:** `baro stop` becomes self-cleaning for detached and early-killed runs; a stop that fails leaves the record so the run remains discoverable. `remove_record` is idempotent (missing file → `false`, no panic). This story writes only run_registry.rs, so it stays disjoint from the ADR-001 story that writes orchestrator_client.rs and main.rs.
