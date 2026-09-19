# ADR-0015: #149: Read the runner token from the environment or a 0600 file, re-exec without it in argv, and keep it out of service files

**Status:** Accepted
**Context:** The token comes from RUNNER_TOKEN or --token and is embedded in plaintext in the plist, the systemd unit and the schtasks command. Rust std cannot rewrite argv in place.
**Decision:** New file crates/baro-tui/src/cli/runner_token.rs:
- `token_file() -> PathBuf` = baro_home()/runner-token.
- `resolve_runner_token(flag: Option<String>) -> Option<String>`. Precedence: --token, then BARO_RUNNER_TOKEN, then RUNNER_TOKEN, then the file.
- `write_token_file(tok)`: creates the directory and sets mode 0600 on unix.
- `scrub_token_args(args:&[String]) -> Vec<String>`: drops `--token X` and `--token=X`.

run_connect:
- After parsing, if the token came from argv, re-exec current_exe with scrub_token_args and BARO_RUNNER_TOKEN in the environment. On unix use CommandExt::exec, which replaces the process. On Windows, spawn, wait and exit with the child's code.

--install-service:
- Calls write_token_file, then service::install without a token.
- service.rs drops the token parameter. The relaunch command is `connect --service --workspace <abs> [--control-url]`.
- The plist, unit and schtasks rendering move into pure fns `launchd_plist(..)`, `systemd_unit(..)`, `windows_task_action(..)`.

Tests: scrub_token_args output has no token, and none of the three renders contains a sample token.
**Consequences:** scripts/runner-helpers.ts buildInstallServiceArgs still passes --token once; this is acceptable because install now persists it to the file. Update usage.rs help to mention BARO_RUNNER_TOKEN and the file.
