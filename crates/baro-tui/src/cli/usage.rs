//! Single source of the pre-clap usage text and of the help/version decision for
//! the six raw-argv commands. `concat!` takes only literals, so wording shared
//! between the `--help` epilogue and the per-command usage lives in
//! literal-producing macros rather than in the consts they also build.

macro_rules! connect_invocation {
    () => {
        "baro connect [--token <rt_…>]"
    };
}
macro_rules! connect_purpose {
    () => {
        "pair this machine with baro-cloud and run dispatched goals"
    };
}
macro_rules! login_invocation {
    () => {
        "baro login"
    };
}
macro_rules! login_purpose {
    () => {
        "sign in with a browser and store a runner credential"
    };
}
macro_rules! runs_invocation {
    () => {
        "baro runs"
    };
}
macro_rules! runs_purpose {
    () => {
        "list the runs live on this machine"
    };
}
macro_rules! stop_invocation {
    () => {
        "baro stop <run-id>"
    };
}
macro_rules! stop_purpose {
    () => {
        "stop a live run started from another terminal"
    };
}
macro_rules! watch_invocation {
    () => {
        "baro watch <run-id>"
    };
}
macro_rules! watch_purpose {
    () => {
        "follow a live run and print milestone events"
    };
}
macro_rules! logs_invocation {
    () => {
        "baro logs <run-id> [--follow]"
    };
}
macro_rules! logs_purpose {
    () => {
        "print (or tail) a run's log file"
    };
}

macro_rules! connect_summary {
    () => {
        concat!("  ", connect_invocation!(), "  ", connect_purpose!())
    };
}
macro_rules! login_summary {
    () => {
        concat!("  ", login_invocation!(), "                     ", login_purpose!())
    };
}
macro_rules! runs_summary {
    () => {
        concat!("  ", runs_invocation!(), "                      ", runs_purpose!())
    };
}
macro_rules! stop_summary {
    () => {
        concat!("  ", stop_invocation!(), "             ", stop_purpose!())
    };
}
macro_rules! watch_summary {
    () => {
        concat!("  ", watch_invocation!(), "            ", watch_purpose!())
    };
}
macro_rules! logs_summary {
    () => {
        concat!("  ", logs_invocation!(), "  ", logs_purpose!())
    };
}

macro_rules! common_flags {
    () => {
        "  -h, --help             print this help\n  --version              print the version\n"
    };
}

// The binary reaches these bytes through AFTER_HELP; the consts exist so the
// epilogue drift tests in cli.rs and main.rs assert on the wording, not a copy.
#[allow(dead_code)]
pub(crate) const CONNECT_SUMMARY: &str = connect_summary!();
#[allow(dead_code)]
pub(crate) const LOGIN_SUMMARY: &str = login_summary!();
#[allow(dead_code)]
pub(crate) const RUNS_SUMMARY: &str = runs_summary!();
#[allow(dead_code)]
pub(crate) const STOP_SUMMARY: &str = stop_summary!();
#[allow(dead_code)]
pub(crate) const WATCH_SUMMARY: &str = watch_summary!();
#[allow(dead_code)]
pub(crate) const LOGS_SUMMARY: &str = logs_summary!();

pub const AFTER_HELP: &str = concat!(
    "Run commands (handled before flag parsing):\n",
    connect_summary!(),
    "\n",
    login_summary!(),
    "\n",
    runs_summary!(),
    "\n",
    stop_summary!(),
    "\n",
    watch_summary!(),
    "\n",
    logs_summary!(),
    "\n\n--resume never re-plans; --continue always re-plans.\n\nIssues: https://github.com/jigjoy-ai/baro/issues\nTwitter: @lotus_sbc"
);

/// Matches clap's bare `version` attribute output for `name = "baro"`.
pub const VERSION_LINE: &str = concat!("baro ", env!("CARGO_PKG_VERSION"));

pub const CONNECT_USAGE: &str = concat!(
    "Usage: ",
    connect_invocation!(),
    " [--workspace <dir>]\n\n",
    "Connect: ",
    connect_purpose!(),
    ".\n",
    "Run `baro login` first and the token is optional — connect signs in automatically.\n\nFlags:\n",
    "  --token <rt_…>         runner token to pair with (default: $RUNNER_TOKEN)\n",
    "  --workspace <dir>      git repo to run goals in, alias --cwd (default: $WORKSPACE_DIR)\n",
    "  --control-url <url>    control plane to pair against (default: $CONTROL_URL)\n",
    "  --install-service      install a background service (launchd/systemd/Task Scheduler)\n",
    "                         so the runner survives terminal close, logout, and reboot\n",
    "  --uninstall-service    remove that service\n",
    "  --once                 run exactly one dispatched goal, then exit (cloud workers)\n",
    "  --service              mark this as the managed-service invocation\n",
    "  --no-service           don't offer to install the background service after pairing\n",
    common_flags!(),
    "\nExample:\n  baro connect --token rt_abc123 --workspace ~/code/my-repo\n"
);

pub const LOGIN_USAGE: &str = concat!(
    "Usage: ",
    login_invocation!(),
    "\n\n",
    "Login: ",
    login_purpose!(),
    ".\nTakes no extra flags.\n\nFlags:\n",
    common_flags!(),
    "\nExample:\n  baro login\n"
);

pub const RUNS_USAGE: &str = concat!(
    "Usage: ",
    runs_invocation!(),
    "\n\n",
    "Runs: ",
    runs_purpose!(),
    ".\nTakes no extra flags.\n\nFlags:\n",
    common_flags!(),
    "\nExample:\n  baro runs\n"
);

pub const STOP_USAGE: &str = concat!(
    "Usage: ",
    stop_invocation!(),
    "\n\n",
    "Stop: ",
    stop_purpose!(),
    ".\nList the ids with `baro runs`.\n\nFlags:\n",
    common_flags!(),
    "\nExample:\n  baro stop r-1a2b\n"
);

pub const WATCH_USAGE: &str = concat!(
    "Usage: ",
    watch_invocation!(),
    "\n\n",
    "Watch: ",
    watch_purpose!(),
    ".\nList the ids with `baro runs`.\n\nFlags:\n",
    common_flags!(),
    "\nExample:\n  baro watch r-1a2b\n"
);

pub const LOGS_USAGE: &str = concat!(
    "Usage: ",
    logs_invocation!(),
    "\n\n",
    "Logs: ",
    logs_purpose!(),
    ".\nList the ids with `baro runs`.\n\nFlags:\n",
    "  --follow               tail the log instead of printing it once\n",
    common_flags!(),
    "\nExample:\n  baro logs r-1a2b --follow\n"
);

pub const PRE_CLAP_COMMANDS: [&str; 6] = ["connect", "login", "runs", "stop", "watch", "logs"];

#[derive(Debug, PartialEq, Eq)]
pub enum PreClapResponse {
    Help(&'static str),
    Version,
}

const USAGES: [&str; 6] = [
    CONNECT_USAGE,
    LOGIN_USAGE,
    RUNS_USAGE,
    STOP_USAGE,
    WATCH_USAGE,
    LOGS_USAGE,
];

pub fn usage_for(command: &str) -> Option<&'static str> {
    let index = PRE_CLAP_COMMANDS.iter().position(|name| *name == command)?;
    Some(USAGES[index])
}

/// `args` is the tail after the command word. Value-consuming flags are
/// deliberately not modelled: `connect --token --help` is help.
pub fn pre_clap_response(command: &str, args: &[String]) -> Option<PreClapResponse> {
    let usage = usage_for(command)?;
    args.iter().find_map(|arg| match arg.as_str() {
        "-h" | "--help" => Some(PreClapResponse::Help(usage)),
        "--version" => Some(PreClapResponse::Version),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::*;
    use crate::cli::cli::Cli;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn login_help_returns_help_text() {
        for flag in ["--help", "-h"] {
            assert_eq!(
                pre_clap_response("login", &argv(&[flag])),
                Some(PreClapResponse::Help(LOGIN_USAGE))
            );
        }
        assert!(LOGIN_USAGE.contains("Usage: baro login"));
    }

    #[test]
    fn connect_usage_lists_real_flags_and_one_example() {
        for flag in ["--help", "-h"] {
            assert_eq!(
                pre_clap_response("connect", &argv(&[flag])),
                Some(PreClapResponse::Help(CONNECT_USAGE))
            );
        }
        for expected in [
            "Usage: baro connect",
            "--token",
            "--workspace",
            "--cwd",
            "--control-url",
            "--install-service",
            "--uninstall-service",
            "--once",
            "--service",
            "--no-service",
            "-h, --help",
            "--version",
        ] {
            assert!(CONNECT_USAGE.contains(expected), "CONNECT_USAGE missing {expected}");
        }
        assert!(!CONNECT_USAGE.contains("--name"), "connect has no --name flag");
        assert_eq!(CONNECT_USAGE.matches("Example:").count(), 1);
    }

    #[test]
    fn positional_then_help_returns_help() {
        let cases = [
            ("runs", vec!["-h"], RUNS_USAGE),
            ("stop", vec!["r-1", "--help"], STOP_USAGE),
            ("watch", vec!["r-1", "-h"], WATCH_USAGE),
            ("logs", vec!["r-1", "--help"], LOGS_USAGE),
        ];
        for (command, args, usage) in cases {
            assert_eq!(
                pre_clap_response(command, &argv(&args)),
                Some(PreClapResponse::Help(usage)),
                "{command} {args:?}"
            );
        }
    }

    #[test]
    fn version_line_matches_clap_and_all_six_commands() {
        assert_eq!(VERSION_LINE, format!("baro {}", env!("CARGO_PKG_VERSION")));
        let rendered = Cli::command().render_version().to_string();
        assert_eq!(rendered.lines().next(), Some(VERSION_LINE));
        for command in PRE_CLAP_COMMANDS {
            assert_eq!(
                pre_clap_response(command, &argv(&["--version"])),
                Some(PreClapResponse::Version),
                "{command}"
            );
        }
        // First match in argv order wins.
        assert_eq!(
            pre_clap_response("logs", &argv(&["r-1", "--version", "--help"])),
            Some(PreClapResponse::Version)
        );
        assert_eq!(
            pre_clap_response("logs", &argv(&["r-1", "--help", "--version"])),
            Some(PreClapResponse::Help(LOGS_USAGE))
        );
    }

    #[test]
    fn no_help_token_returns_none() {
        assert_eq!(pre_clap_response("logs", &argv(&["r-1", "--follow"])), None);
        assert_eq!(pre_clap_response("connect", &argv(&["--token", "t"])), None);
        assert_eq!(pre_clap_response("plan", &argv(&["--help"])), None);
        assert_eq!(pre_clap_response("runs", &[]), None);
        for near_miss in ["--help=1", "-hv", "--hel", "help", "--versions"] {
            assert_eq!(pre_clap_response("runs", &argv(&[near_miss])), None, "{near_miss}");
        }
        // Value-consuming flags are not modelled: this is help, not a token value.
        assert_eq!(
            pre_clap_response("connect", &argv(&["--token", "--help"])),
            Some(PreClapResponse::Help(CONNECT_USAGE))
        );
    }

    #[test]
    fn usage_consts_have_required_sections() {
        for (command, usage, invocation) in [
            ("connect", CONNECT_USAGE, "Usage: baro connect"),
            ("login", LOGIN_USAGE, "Usage: baro login"),
            ("runs", RUNS_USAGE, "Usage: baro runs"),
            ("stop", STOP_USAGE, "Usage: baro stop <run-id>"),
            ("watch", WATCH_USAGE, "Usage: baro watch <run-id>"),
            ("logs", LOGS_USAGE, "Usage: baro logs <run-id> [--follow]"),
        ] {
            assert_eq!(usage_for(command), Some(usage));
            assert!(usage.starts_with(invocation), "{command} usage line");
            assert!(usage.contains("\nFlags:\n"), "{command} flags block");
            assert!(usage.contains("-h, --help"), "{command} help flag");
            assert_eq!(usage.matches("Example:").count(), 1, "{command} example count");
            assert!(usage.ends_with('\n'), "{command} trailing newline");
        }
        assert!(RUNS_USAGE.contains("Takes no extra flags."));
        assert!(LOGIN_USAGE.contains("Takes no extra flags."));
        assert!(!STOP_USAGE.contains("--follow"));
        assert!(!WATCH_USAGE.contains("--follow"));
        assert!(LOGS_USAGE.contains("--follow               tail the log"));
    }

    #[test]
    fn after_help_contains_every_summary() {
        assert!(AFTER_HELP.starts_with("Run commands (handled before flag parsing):\n"));
        for summary in [
            CONNECT_SUMMARY,
            LOGIN_SUMMARY,
            RUNS_SUMMARY,
            STOP_SUMMARY,
            WATCH_SUMMARY,
            LOGS_SUMMARY,
        ] {
            assert!(AFTER_HELP.contains(summary), "AFTER_HELP missing {summary}");
        }
        assert!(AFTER_HELP.contains("baro watch <run-id>"));
        assert!(AFTER_HELP.contains("baro logs <run-id> [--follow]"));
        assert!(AFTER_HELP.contains("--resume never re-plans; --continue always re-plans."));
        assert!(AFTER_HELP.contains("Issues: https://github.com/jigjoy-ai/baro/issues"));
        assert!(AFTER_HELP.contains("Twitter: @lotus_sbc"));
    }
}
