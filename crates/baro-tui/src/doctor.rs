//! `baro doctor` — quick self-diagnostic that verifies the moving parts
//! baro depends on before a real run starts. Run when a run fails in
//! a way that doesn't make it clear which piece broke (e.g. issue #17,
//! where the planner exited with code 1 and an empty stderr because
//! `claude` wasn't authenticated).
//!
//! Exits 0 if every check passes, 1 if any fail. Prints a colored
//! report to stderr with concrete remediation hints per failure.

use std::path::PathBuf;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_DIM: &str = "\x1b[2m";
const ANSI_BOLD: &str = "\x1b[1m";
const ANSI_GREEN: &str = "\x1b[32m";
const ANSI_RED: &str = "\x1b[31m";
const ANSI_YELLOW: &str = "\x1b[33m";

/// Result of one check.
struct CheckResult {
    name: &'static str,
    ok: bool,
    detail: String,
    hint: Option<&'static str>,
}

impl CheckResult {
    fn pass(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, ok: true, detail: detail.into(), hint: None }
    }
    fn fail(name: &'static str, detail: impl Into<String>, hint: &'static str) -> Self {
        Self { name, ok: false, detail: detail.into(), hint: Some(hint) }
    }
}

/// Entry point. Returns Ok(0) if every check passed, Ok(1) if any failed.
/// Never returns an Err — every error becomes a fail row in the report.
pub async fn run() -> i32 {
    let mut results: Vec<CheckResult> = Vec::new();

    results.push(check_claude_on_path().await);
    results.push(check_claude_version().await);
    results.push(check_claude_print_call().await);
    results.push(check_codex_on_path().await);
    results.push(check_opencode_on_path().await);
    results.push(check_copilot_on_path().await);
    results.push(check_gh_on_path().await);
    results.push(check_audit_dir_writable().await);

    print_report(&results);
    if results.iter().all(|r| r.ok) { 0 } else { 1 }
}

// ─── Individual checks ─────────────────────────────────────────────

/// Verify `claude` binary is reachable. Resolves PATH lookup and
/// returns the full path if found.
async fn check_claude_on_path() -> CheckResult {
    match which::which("claude") {
        Ok(path) => CheckResult::pass(
            "claude on PATH",
            format!("{}", path.display()),
        ),
        Err(_) => CheckResult::fail(
            "claude on PATH",
            "binary not found",
            "Install Claude Code from https://claude.com/code (or run `which claude` to see why your shell can't find it).",
        ),
    }
}

/// Run `claude --version`. Hard timeout 5s so a hung install can't
/// freeze the doctor.
async fn check_claude_version() -> CheckResult {
    let mut cmd = Command::new("claude");
    cmd.arg("--version");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let spawn_then_wait = async {
        let child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;
        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("wait failed: {}", e))?;
        Ok::<_, String>(output)
    };

    match timeout(Duration::from_secs(5), spawn_then_wait).await {
        Err(_) => CheckResult::fail(
            "claude --version",
            "timed out after 5s",
            "`claude --version` hung. Try running it manually; if it still hangs, reinstall Claude Code.",
        ),
        Ok(Err(e)) => CheckResult::fail(
            "claude --version",
            e,
            "Reinstall Claude Code or check that the binary on PATH is actually claude.",
        ),
        Ok(Ok(output)) => {
            if output.status.success() {
                let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
                CheckResult::pass("claude --version", v)
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                CheckResult::fail(
                    "claude --version",
                    format!("exit {}: {}", output.status.code().unwrap_or(-1), stderr),
                    "Claude binary is on PATH but returned an error on a trivial call. Try `claude doctor` (Claude's own check), then reinstall.",
                )
            }
        }
    }
}

/// Run a trivial authenticated `claude --print` call. This is the
/// real test — if this succeeds, the planner will run. If it fails,
/// the user is almost certainly not logged in (which is the issue
/// #17 scenario: empty stderr, exit 1, no clue why).
async fn check_claude_print_call() -> CheckResult {
    let mut cmd = Command::new("claude");
    cmd.args([
        "--print",
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
        "-p",
        "Say the single word OK and nothing else.",
    ]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let spawn_then_wait = async {
        let child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;
        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("wait failed: {}", e))?;
        Ok::<_, String>(output)
    };

    match timeout(Duration::from_secs(30), spawn_then_wait).await {
        Err(_) => CheckResult::fail(
            "claude --print authenticated call",
            "timed out after 30s",
            "Trivial `claude --print` hung for 30s. Network problem, or Claude CLI is stuck waiting on auth.",
        ),
        Ok(Err(e)) => CheckResult::fail(
            "claude --print authenticated call",
            e,
            "Could not invoke claude. See `claude on PATH` check above.",
        ),
        Ok(Ok(output)) => {
            if output.status.success() {
                CheckResult::pass(
                    "claude --print authenticated call",
                    "ok (got JSON response)",
                )
            } else {
                let code = output.status.code().unwrap_or(-1);
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let detail = if stderr.is_empty() && stdout.is_empty() {
                    format!("exit {}, no output (auth failure is the common cause)", code)
                } else if stderr.is_empty() {
                    format!("exit {}, stdout: {}", code, truncate(&stdout, 200))
                } else {
                    format!("exit {}, stderr: {}", code, truncate(&stderr, 200))
                };
                CheckResult::fail(
                    "claude --print authenticated call",
                    detail,
                    "Run `claude` (no args) once interactively to authenticate. If you've logged in but still see this, your subscription may be expired or rate-limited. See https://docs.baro.rs/docs/troubleshooting.",
                )
            }
        }
    }
}

/// `gh` is only required for the Finalizer (PR creation). A failing
/// gh check is a warning, not a fatal error — the run will still
/// complete, the user just won't get an auto-PR.
/// Verify `codex` binary is reachable (optional — only needed for
/// `baro --llm codex`). Soft failure: codex is optional infrastructure
/// for the third backend; not having it doesn't block Claude or
/// OpenAI workflows.
async fn check_codex_on_path() -> CheckResult {
    match which::which("codex") {
        Ok(path) => CheckResult::pass(
            "codex on PATH (optional, used for --llm codex)",
            format!("{}", path.display()),
        ),
        Err(_) => CheckResult::fail(
            "codex on PATH (optional, used for --llm codex)",
            "binary not found",
            "Install OpenAI Codex CLI from https://developers.openai.com/codex/cli if you want the `--llm codex` subscription path; otherwise this check is informational and Claude / OpenAI routes still work.",
        ),
    }
}

/// Verify `opencode` binary is reachable (optional — only needed for
/// `baro --llm opencode`). Soft failure: opencode is optional
/// infrastructure for the OpenCode backend; not having it doesn't
/// block Claude, OpenAI, or Codex workflows.
async fn check_opencode_on_path() -> CheckResult {
    match which::which("opencode") {
        Ok(path) => CheckResult::pass(
            "opencode on PATH (optional, used for --llm opencode)",
            format!("{}", path.display()),
        ),
        Err(_) => CheckResult::fail(
            "opencode on PATH (optional, used for --llm opencode)",
            "binary not found",
            "Install opencode from https://opencode.ai if you want the `--llm opencode` multi-provider path; otherwise this check is informational and other routes still work.",
        ),
    }
}

/// Verify `copilot` binary is reachable (optional — only needed for
/// `baro --llm copilot`). Soft failure: copilot is optional
/// infrastructure for the Copilot backend; not having it doesn't
/// block Claude, OpenAI, Codex, or OpenCode workflows.
async fn check_copilot_on_path() -> CheckResult {
    match which::which("copilot") {
        Ok(path) => CheckResult::pass(
            "copilot on PATH (optional, used for --llm copilot)",
            format!("{}", path.display()),
        ),
        Err(_) => CheckResult::fail(
            "copilot on PATH (optional, used for --llm copilot)",
            "binary not found",
            "Install the GitHub Copilot CLI from https://docs.github.com/copilot/concepts/agents/about-copilot-cli if you want the `--llm copilot` path; otherwise this check is informational and other routes still work.",
        ),
    }
}

async fn check_gh_on_path() -> CheckResult {
    match which::which("gh") {
        Ok(path) => CheckResult::pass(
            "gh on PATH (optional, used for PR creation)",
            format!("{}", path.display()),
        ),
        Err(_) => CheckResult::fail(
            "gh on PATH (optional, used for PR creation)",
            "not found",
            "Optional but recommended: install GitHub CLI from https://cli.github.com to let baro auto-open a PR after every run. Without it, baro will push the branch but you'll open the PR yourself.",
        ),
    }
}

/// Verify we can write to ~/.baro/runs/. Audit logs and stderr
/// sidecars from real runs land here. If it's root-owned (sudo
/// install accident) we want to know now, not mid-run.
async fn check_audit_dir_writable() -> CheckResult {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => {
            return CheckResult::fail(
                "audit dir writable",
                "$HOME is unset",
                "baro writes audit logs to $HOME/.baro/runs. Set HOME and re-run.",
            );
        }
    };
    let dir = home.join(".baro").join("runs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return CheckResult::fail(
            "audit dir writable",
            format!("create_dir_all({}) failed: {}", dir.display(), e),
            "Try `sudo chown -R $(id -u):$(id -g) ~/.baro` if you ever installed baro with sudo.",
        );
    }
    let probe = dir.join(".doctor-write-probe");
    match std::fs::write(&probe, b"baro doctor probe") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            CheckResult::pass(
                "audit dir writable",
                format!("{}", dir.display()),
            )
        }
        Err(e) => CheckResult::fail(
            "audit dir writable",
            format!("write probe failed: {}", e),
            "Try `sudo chown -R $(id -u):$(id -g) ~/.baro` if you ever installed baro with sudo.",
        ),
    }
}

// ─── Reporting ─────────────────────────────────────────────────────

fn print_report(results: &[CheckResult]) {
    eprintln!();
    eprintln!("{}baro doctor{}", ANSI_BOLD, ANSI_RESET);
    eprintln!("{}{}{}", ANSI_DIM, "─".repeat(60), ANSI_RESET);
    eprintln!();

    for r in results {
        let (mark, color) = if r.ok {
            ("\u{2713}", ANSI_GREEN)
        } else {
            ("\u{2717}", ANSI_RED)
        };
        eprintln!(
            "  {}{}{}  {}{}{}",
            color, mark, ANSI_RESET, ANSI_BOLD, r.name, ANSI_RESET,
        );
        eprintln!("      {}{}{}", ANSI_DIM, r.detail, ANSI_RESET);
        if let Some(hint) = r.hint {
            eprintln!("      {}{}\u{2192}{} {}{}{}", ANSI_YELLOW, ANSI_BOLD, ANSI_RESET, ANSI_YELLOW, hint, ANSI_RESET);
        }
        eprintln!();
    }

    eprintln!("{}{}{}", ANSI_DIM, "─".repeat(60), ANSI_RESET);
    let passed = results.iter().filter(|r| r.ok).count();
    let total = results.len();
    if passed == total {
        eprintln!(
            "  {}{}{} {}all checks passed ({}/{}){}",
            ANSI_GREEN, ANSI_BOLD, "\u{2713}", ANSI_BOLD, passed, total, ANSI_RESET,
        );
    } else {
        let failed = total - passed;
        eprintln!(
            "  {}{}{} {}{} of {} checks failed{}",
            ANSI_RED, ANSI_BOLD, "\u{2717}", ANSI_BOLD, failed, total, ANSI_RESET,
        );
        eprintln!();
        eprintln!(
            "  {}Full troubleshooting guide: https://docs.baro.rs/docs/troubleshooting{}",
            ANSI_DIM, ANSI_RESET,
        );
    }
    eprintln!();
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(n).collect();
        format!("{}\u{2026}", truncated)
    }
}
