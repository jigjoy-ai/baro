# ADR-0014: #119: Make the subprocess descendant test wait for an observable signal instead of a delay

**Status:** Accepted
**Context:** The fixture in subprocess.rs:557-595 backgrounds a TERM-ignoring sleeper and exits 7 without confirming the sleeper is running.
**Decision:** The fixture creates a temp pid file.

The script becomes:
`sh -c 'trap "" TERM; echo $$ > "$PIDFILE"; exec sleep 30' & while [ ! -s "$PIDFILE" ]; do :; done; exit 7`

The test reads the descendant pid from the file, then polls unix_process_exists until a deadline, as it does today.

If the code under test snapshots descendants before readiness, change it to kill the process group or session, not a pid snapshot.

Stability check: `for i in $(seq 20); do cargo test -p baro-tui nonzero_exit_terminates_inherited_pipe_descendants || exit 1; done` after `cargo clean -p baro-tui`.
**Consequences:** Unix-only, as today. No new dependency.
