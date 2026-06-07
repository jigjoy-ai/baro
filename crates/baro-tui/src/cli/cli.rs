use std::{fs};

use clap::{CommandFactory, Error, Parser, error::ErrorKind};

use crate::cli::session::SessionLock;

#[derive(Parser)]
#[command(
    name = "baro",
    version,
    about = "AI-Powered project executio",
    after_help = "Issues: https://github.com/jigjoy-ai/baro/issues\nTwitter: @lotus_sbc"
)]
pub struct Cli {
    pub goal: Option<String>,

    #[arg(long, default_value="claude", value_parser = ["claude", "openai"])]
    pub planner: String,

    #[arg(long, default_value = ".")]
    pub cwd: String,

    #[arg(long)]
    pub resume: bool,

    #[arg(long, default_value = "0")]
    pub parallel: u32,

    #[arg(long, default_value = "0")]
    pub timeout: Option<u64>,

    #[arg(long = "model", short = 'm')]
    pub model: Option<String>,

    #[arg(long, value_parser=["low", "medium", "high", "xhigh", "max"], default_value="high")]
    pub effort: String,

    #[arg(long = "no-modle-routing")]
    pub no_model_routing: bool,

    #[arg(long)]
    pub no_critic: bool,

    #[arg(long)]
    pub no_librarian: bool,

    #[arg(long)]
    pub no_sentry: bool,

    #[arg(long)]
    pub no_surgeon: bool,

    #[arg(long)]
    pub no_surgeon_llm: bool,

    #[arg(long)]
    pub surgeon_model: Option<String>,

    #[arg(long)]
    pub architect_model: Option<String>,

    #[arg(long)]
    pub planner_model: Option<String>,

    #[arg(long)]
    pub critic_model: Option<String>,

    #[arg(long)]
    pub story_model: Option<String>,

    #[arg(long = "tier-map")]
    pub tier_map: Option<String>,

    #[arg(long = "openai-endpoint")]
    pub openai_endpoint: Vec<String>,

    #[arg(long = "intra-level-delay")]
    pub intra_level_delay: Option<u64>,

    #[arg(long)]
    pub doctor: bool,

    #[arg(long)]
    pub quick: bool,

    #[arg(long, default_value="claude", value_parser=["claude", "openai", "codex", "opencode", "pi", "hybrid"])]
    pub llm: String,

    #[arg(long, env = "OPENAI_BASE_URL")]
    pub openai_base_url: Option<String>,

    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub architect_llm: Option<String>,

    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub planner_llm: Option<String>,

    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub story_llm: Option<String>,

    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub critic_llm: Option<String>,

    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub surgeon_llm: Option<String>,

    #[arg(long)]
    pub no_memory: bool,
}

pub fn parse() -> Result<Cli, Error> {
    // TODO: Need to implement furthur parsing to make sure the models and everything works based on Enums rather than string
    let mut cmd = Cli::command(); 
    let cli = Cli::parse();

    let cwd = fs::canonicalize(&cli.cwd)?;

    if !cli.doctor {
        let _lock = match SessionLock::acquire(&cwd) {
            Ok(lock) => lock,
            Err(msg) => {
                return Err(cmd.error(
                    ErrorKind::ValueValidation, 
                    format!("Failed to acquire session lock: {msg}")
                ));
            }
        };
    }

    return Ok(cli);
}
