use std::collections::HashMap;
use std::time::Instant;

use ratatui::widgets::ListState;

use crate::events::{BaroEvent, DoneStats};

use crate::constants::MAX_LOG_LINES;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Screen {
    /// First step (when invoked without a goal): pick Claude Code vs
    /// Mozaik native (OpenAI) as the backend for every LLM-using
    /// phase in this run.
    ProviderPicker,
    /// Shown only when the user picked the OpenAI backend AND
    /// `OPENAI_API_KEY` was not already set in the environment.
    /// Held in memory only; never written to disk.
    ApiKeyInput,
    Welcome,
    Context,
    Planning,
    Review,
    Execute,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Planner {
    Claude,
    OpenAI,
    Codex,
    OpenCode,
    Copilot,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WelcomeField {
    Goal,
    Model,
    Parallel,
    Timeout,
    Planner,
}

impl WelcomeField {
    pub fn next(self) -> Self {
        match self {
            Self::Goal => Self::Model,
            Self::Model => Self::Parallel,
            Self::Parallel => Self::Timeout,
            Self::Timeout => Self::Planner,
            Self::Planner => Self::Goal,
        }
    }
    pub fn prev(self) -> Self {
        match self {
            Self::Goal => Self::Planner,
            Self::Model => Self::Goal,
            Self::Parallel => Self::Model,
            Self::Timeout => Self::Parallel,
            Self::Planner => Self::Timeout,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GlobalTab {
    Dashboard,
    Dag,
    Stats,
}

impl GlobalTab {
    pub fn next(self) -> Self {
        match self {
            Self::Dashboard => Self::Dag,
            Self::Dag => Self::Stats,
            Self::Stats => Self::Dashboard,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Dashboard => Self::Stats,
            Self::Dag => Self::Dashboard,
            Self::Stats => Self::Dag,
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::Dashboard => 0,
            Self::Dag => 1,
            Self::Stats => 2,
        }
    }
}

/// Lifecycle of the pre-planner Architect phase. Reflected in the TUI
/// welcome / planning view so the user knows whether they're waiting on
/// the design pass, the decomposition pass, or both.
#[derive(Debug, Clone, PartialEq)]
pub enum ArchitectStatus {
    Idle,
    Running,
    Complete,
    /// Architect phase failed but we're continuing — the planner runs
    /// without an authoritative spec (legacy behaviour).
    Skipped(String),
}

/// Which LLM provider every phase routes its calls to. Claude (default)
/// shells out to the Claude Code CLI. OpenAI uses Mozaik 3.9's native
/// providers/openai inference runner. Selectable via `baro --llm <value>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProvider {
    Claude,
    OpenAI,
    /// OpenAI Codex CLI subprocess. Same subscription-arbitrage shape
    /// as Claude (subprocess wrapping a vendor CLI billed against a
    /// consumer ChatGPT plan rather than per-token API), but a
    /// different binary, different JSONL event schema, and one-shot
    /// non-interactive invocation per turn (no stdin streaming).
    /// Implementation: `packages/baro-orchestrator/src/participants/
    /// codex-cli-participant.ts`.
    Codex,
    /// OpenCode CLI subprocess. Multi-provider agent shell that outputs
    /// JSONL via `opencode run --format json`. Supports any model via
    /// `-m provider/model` flag. One-shot non-interactive invocation.
    /// Implementation: `packages/baro-orchestrator/src/participants/
    /// opencode-cli-participant.ts`.
    OpenCode,
    /// GitHub Copilot CLI subprocess. One-shot non-interactive invocation
    /// (`copilot -p ... --output-format json`) emitting JSONL, modeled on
    /// the Codex backend. Uses its own `gh`/Copilot auth.
    /// Implementation: `packages/baro-orchestrator/src/participants/
    /// copilot-cli-participant.ts`.
    Copilot,
}

impl LlmProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::OpenAI => "openai",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Copilot => "copilot",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "claude" => Some(Self::Claude),
            "openai" => Some(Self::OpenAI),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::OpenCode),
            "copilot" => Some(Self::Copilot),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StoryStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Retrying(u32),
    /// Reserved for stories the orchestrator decides to drop (e.g.
    /// because a dependency failed terminally). Currently never
    /// constructed — terminal retry-exhaustion now uses `Failed` so the
    /// user isn't told their work was "skipped" when it was actually
    /// attempted. Kept around for an upcoming `story_dropped` event.
    #[allow(dead_code)]
    Skipped,
}

#[derive(Debug, Clone)]
pub struct StoryState {
    pub id: String,
    pub title: String,
    pub depends_on: Vec<String>,
    pub status: StoryStatus,
    pub duration_secs: Option<u64>,
    pub error: Option<String>,
    pub files_created: u32,
    pub files_modified: u32,
}

#[derive(Debug, Clone)]
pub struct ActiveStory {
    pub id: String,
    pub title: String,
    pub logs: Vec<String>,
    pub start_time: Instant,
}

#[derive(Debug, Clone)]
pub struct ReviewStory {
    pub id: String,
    pub title: String,
    pub description: String,
    pub depends_on: Vec<String>,
    pub completed: bool,
    pub model: Option<String>,
}

pub struct App {
    // Screen state
    pub screen: Screen,
    pub planner: Planner,

    // Provider-picker screen (first step when invoked without a goal).
    // Index into `provider_picker_options`; the chosen LlmProvider
    // lands in `self.llm` on confirm.
    pub provider_picker_index: usize,
    /// Available backends for the picker, populated at startup. Claude
    /// and OpenAI are always present; Codex and OpenCode are added when
    /// their CLI is detected on PATH.
    pub provider_picker_options: Vec<LlmProvider>,

    // API-key input screen — buffer for the in-progress text. The
    // confirmed key (whether from this input or the environment) is
    // held in `openai_api_key` and passed to subprocesses via env, not
    // written to disk.
    pub api_key_input: String,
    pub openai_api_key: Option<String>,
    /// Optional custom base URL for OpenAI-compatible API endpoints
    /// (e.g. Xiaomi MiMo, OpenRouter, local vLLM). Read from
    /// `OPENAI_BASE_URL` env var or `--openai-base-url` CLI flag.
    pub openai_base_url: Option<String>,
    /// Effort level passed to spawned `claude` processes via
    /// `--effort` (low|medium|high|xhigh|max). Default "high". Set via
    /// `baro --effort`.
    pub effort: String,

    // Welcome screen
    pub goal_input: String,
    pub welcome_field: WelcomeField,

    // Context building screen
    pub claude_md_content: Option<String>,
    /// Architect's DecisionDocument for the current run, captured between
    /// the Architect phase and write_prd. Persists into prd.json so the
    /// orchestrator can prepend it to every story prompt.
    pub decision_document: Option<String>,
    pub architect_status: ArchitectStatus,

    // Planning screen
    pub planning_start: Option<Instant>,
    pub planning_error: Option<String>,
    /// When the planner / architect fails, the path to the full
    /// stdout+stderr log we persisted at the call site (see
    /// claude_runner). Surfaced in the planning screen so users have
    /// somewhere to look when the in-TUI error excerpt isn't enough.
    pub planning_log_path: Option<std::path::PathBuf>,

    // Review screen
    pub branch_name: String,
    pub description: String,
    pub review_stories: Vec<ReviewStory>,
    pub review_scroll: usize,
    pub review_scroll_offset: u16,

    // Execute screen
    pub project: String,
    pub stories: Vec<StoryState>,
    pub dag_levels: Vec<Vec<String>>,
    pub active_stories: HashMap<String, ActiveStory>,
    pub completed: u32,
    pub total: u32,
    pub percentage: u32,
    pub start_time: Instant,
    pub done: bool,
    pub final_stats: Option<DoneStats>,
    pub total_time_secs: u64,
    /// Set when the orchestrator subprocess terminated without sending
    /// a normal `Done` event. The completion screen surfaces this so
    /// the user knows the run did not finish cleanly.
    pub exit_reason: Option<String>,

    // Push tracking
    pub push_results: Vec<(String, bool, Option<String>)>,

    // Review tracking
    pub review_in_progress: bool,
    pub review_level: usize,
    pub review_logs: Vec<String>,

    // Finalize tracking
    pub finalize_in_progress: bool,
    pub pr_url: Option<String>,

    // Resume mode
    pub is_resume: bool,

    // Refinement
    pub refine_input: Option<String>,
    pub refining: bool,

    // Config
    pub parallel_limit: u32,
    pub timeout_secs: u64,

    // Model routing
    pub model_routing: bool,
    pub override_model: Option<String>,

    // Phase 2 / 3 / 4 observers (Mozaik orchestrator participants)
    pub with_critic: bool,
    pub critic_model: Option<String>,
    pub with_librarian: bool,
    pub with_memory: bool,
    pub with_sentry: bool,
    pub with_surgeon: bool,
    pub surgeon_use_llm: bool,
    pub surgeon_model: Option<String>,
    /// Per-phase overrides. Each takes precedence over the routed
    /// default for its phase, but is itself overridden by the
    /// global `override_model` so `--model X` still wins. Plumbed
    /// from `--architect-model` / `--planner-model` / `--story-model`
    /// on the CLI; the per-phase Critic + Surgeon fields above
    /// predate this group and stay separate for backwards compat.
    pub architect_model: Option<String>,
    pub planner_model: Option<String>,
    pub story_model: Option<String>,
    /// Per-story tier→backend:model map from `--tier-map`. Lets one DAG
    /// mix claude/openai/codex story-by-story.
    pub tier_map: Option<String>,
    /// Named OpenAI-compatible endpoints (`name=url`) from
    /// `--openai-endpoint`. Routes reference them via `openai:model@name`.
    pub openai_endpoints: Vec<String>,
    pub intra_level_delay_secs: Option<u64>,

    /// Use the currently checked-out branch instead of creating a new
    /// `baro/<slug>-<timestamp>` branch (set from `--no-branch`). Scoped
    /// to the fresh-run path; resume/rerun already reuse the persisted
    /// branch. Default: false (create a fresh branch).
    pub use_current_branch: bool,

    /// Skip `gh pr create` at end of run (set from `--no-pr`). Branch
    /// creation and pushes still happen; only PR creation is suppressed.
    /// Default: false (create a PR).
    pub skip_pr: bool,

    /// Quick mode (`--quick`): user has told us this goal is trivial and they
    /// want a surgical run. Skips the Architect phase entirely, instructs the
    /// Planner to emit exactly one story, and disables Critic + Surgeon
    /// (which are designed for multi-story runs and add latency the user
    /// explicitly didn't sign up for). The fast path for "fix the typo" goals.
    pub quick: bool,

    /// Which LLM provider runs the agents. Set via `--llm
    /// claude|openai|codex|hybrid`. Read as **the default** every
    /// phase uses unless an explicit per-phase override is set.
    pub llm: LlmProvider,
    /// Per-phase overrides. Each defaults to `llm` when no override
    /// is supplied on the command line. `--llm hybrid` is a preset
    /// that flips these to a sensible split: Architect / Planner /
    /// Surgeon stay on Claude (high-stakes, low-volume); Story and
    /// Critic move to Codex (high-volume, cheap on subscription).
    pub architect_llm: LlmProvider,
    pub planner_llm: LlmProvider,
    pub story_llm: LlmProvider,
    pub critic_llm: LlmProvider,
    pub surgeon_llm: LlmProvider,
    /// True when the user passed `--llm` explicitly (any value, including
    /// `claude` and `hybrid`). The provider picker is shown only when no
    /// `--llm` was given — keying on `llm != Claude` was wrong because
    /// the `hybrid` preset and an explicit `--llm claude` both resolve
    /// `llm` to Claude, which wrongly re-prompted (and, for hybrid, the
    /// picker then collapsed the per-phase split).
    pub llm_explicitly_set: bool,

    // Notification flag
    pub notification_ready: bool,

    // Token usage tracking
    pub token_usage: HashMap<String, (u64, u64)>,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,

    // UI state
    pub global_tab: GlobalTab,
    pub selected_log_index: usize,
    pub tick_count: u64,
    pub story_list_state: ListState,
    pub dag_scroll_offset: u16,
    pub log_scroll_offsets: HashMap<String, usize>,
    pub review_log_scroll_offset: usize,
}

impl App {
    pub fn new() -> Self {
        Self {
            screen: Screen::Welcome,
            planner: Planner::Claude,

            provider_picker_index: 0,
            provider_picker_options: {
                let mut opts = vec![LlmProvider::Claude, LlmProvider::OpenAI];
                if which::which("codex").is_ok() {
                    opts.push(LlmProvider::Codex);
                }
                if which::which("opencode").is_ok() {
                    opts.push(LlmProvider::OpenCode);
                }
                if which::which("copilot").is_ok() {
                    opts.push(LlmProvider::Copilot);
                }
                opts
            },
            api_key_input: String::new(),
            openai_api_key: None,
            openai_base_url: None,
            effort: "high".to_string(),

            goal_input: String::new(),
            welcome_field: WelcomeField::Goal,

            claude_md_content: None,
            decision_document: None,
            architect_status: ArchitectStatus::Idle,

            planning_start: None,
            planning_error: None,
            planning_log_path: None,

            branch_name: String::new(),
            description: String::new(),
            review_stories: Vec::new(),
            review_scroll: 0,
            review_scroll_offset: 0,

            project: String::new(),
            stories: Vec::new(),
            dag_levels: Vec::new(),
            active_stories: HashMap::new(),
            completed: 0,
            total: 0,
            percentage: 0,
            start_time: Instant::now(),
            done: false,
            final_stats: None,
            total_time_secs: 0,
            exit_reason: None,
            push_results: Vec::new(),
            review_in_progress: false,
            review_level: 0,
            review_logs: Vec::new(),
            finalize_in_progress: false,
            pr_url: None,
            is_resume: false,
            refine_input: None,
            refining: false,
            parallel_limit: 0,
            timeout_secs: 0, // 0 = auto (orchestrator effort-scales the per-story timeout)
            notification_ready: false,
            model_routing: true,
            override_model: None,
            with_critic: true,
            critic_model: None,
            with_librarian: true,
            with_memory: true,
            with_sentry: true,
            with_surgeon: true,
            surgeon_use_llm: true,
            surgeon_model: None,
            architect_model: None,
            planner_model: None,
            story_model: None,
            tier_map: None,
            openai_endpoints: Vec::new(),
            intra_level_delay_secs: None,
            use_current_branch: false,
            skip_pr: false,
            quick: false,
            llm: LlmProvider::Claude,
            architect_llm: LlmProvider::Claude,
            planner_llm: LlmProvider::Claude,
            story_llm: LlmProvider::Claude,
            critic_llm: LlmProvider::Claude,
            surgeon_llm: LlmProvider::Claude,
            llm_explicitly_set: false,
            token_usage: HashMap::new(),
            total_input_tokens: 0,
            total_output_tokens: 0,
            global_tab: GlobalTab::Dashboard,
            selected_log_index: 0,
            tick_count: 0,
            story_list_state: ListState::default(),
            dag_scroll_offset: 0,
            log_scroll_offsets: HashMap::new(),
            review_log_scroll_offset: usize::MAX,
        }
    }

    // Screen transitions
    pub fn start_context(&mut self) {
        self.screen = Screen::Context;
        self.tick_count = 0;
    }

    pub fn start_planning(&mut self) {
        self.screen = Screen::Planning;
        self.planning_start = Some(Instant::now());
    }

    pub fn show_review(&mut self, stories: Vec<ReviewStory>) {
        self.review_stories = stories;
        self.review_scroll = 0;
        self.review_scroll_offset = 0;
        self.screen = Screen::Review;
    }

    pub fn start_execution(&mut self) {
        self.screen = Screen::Execute;
        self.start_time = Instant::now();
        self.dag_scroll_offset = 0;
        self.active_stories.clear();
        self.selected_log_index = 0;
        self.completed = 0;
        self.percentage = 0;
        self.final_stats = None;
        self.done = false;
        self.exit_reason = None;
        self.finalize_in_progress = false;
        self.pr_url = None;
        self.push_results.clear();
        self.token_usage.clear();
        self.total_input_tokens = 0;
        self.total_output_tokens = 0;
        self.stories.clear();
    }

    pub fn planning_elapsed_secs(&self) -> u64 {
        self.planning_start
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0)
    }

    // Planner toggle (Welcome screen radio). Cycles the backend AND
    // reconciles it into the routing fields. Execution routes off
    // `llm` / `*_llm` / `model_for_phase` — NOT the legacy `planner`
    // enum — so mutating `planner` alone (the old behaviour) left the
    // radio cosmetic: picking opencode/codex/openai on the Welcome
    // screen still ran every phase on Claude. We now propagate the
    // selection to all routing fields so the chosen backend actually
    // drives the run, matching what the ProviderPicker Enter handler
    // does.
    pub fn toggle_planner(&mut self) {
        self.planner = match self.planner {
            Planner::Claude => Planner::OpenAI,
            Planner::OpenAI => Planner::Codex,
            Planner::Codex => Planner::OpenCode,
            Planner::OpenCode => Planner::Copilot,
            Planner::Copilot => Planner::Claude,
        };
        let provider = match self.planner {
            Planner::Claude => LlmProvider::Claude,
            Planner::OpenAI => LlmProvider::OpenAI,
            Planner::Codex => LlmProvider::Codex,
            Planner::OpenCode => LlmProvider::OpenCode,
            Planner::Copilot => LlmProvider::Copilot,
        };
        self.llm = provider;
        self.architect_llm = provider;
        self.planner_llm = provider;
        self.story_llm = provider;
        self.critic_llm = provider;
        self.surgeon_llm = provider;
    }

    // Execute screen tab navigation
    pub fn next_tab(&mut self) {
        self.global_tab = self.global_tab.next();
    }

    pub fn prev_tab(&mut self) {
        self.global_tab = self.global_tab.prev();
    }

    pub fn next_log(&mut self) {
        let count = self.active_stories.len();
        if count > 0 {
            self.selected_log_index = (self.selected_log_index + 1) % count;
        }
    }

    pub fn prev_log(&mut self) {
        let count = self.active_stories.len();
        if count > 0 {
            self.selected_log_index = if self.selected_log_index == 0 {
                count - 1
            } else {
                self.selected_log_index - 1
            };
        }
    }

    /// Scroll the active story's log panel up by `lines`. Pins position (stops auto-scroll).
    pub fn log_scroll_up(&mut self, lines: usize, total_logs: usize, inner_height: usize) {
        let tail = total_logs.saturating_sub(inner_height);
        let ids = self.active_story_ids();
        if let Some(id) = ids.get(self.selected_log_index) {
            let entry = self.log_scroll_offsets.entry(id.clone()).or_insert(usize::MAX);
            if *entry == usize::MAX {
                *entry = tail.saturating_sub(lines);
            } else {
                *entry = entry.saturating_sub(lines);
            }
        }
    }

    /// Scroll the active story's log panel down by `lines`. Returns to tail (auto-scroll) at MAX.
    pub fn log_scroll_down(&mut self, lines: usize, total_logs: usize, inner_height: usize) {
        let ids = self.active_story_ids();
        if let Some(id) = ids.get(self.selected_log_index) {
            let tail = total_logs.saturating_sub(inner_height);
            let entry = self.log_scroll_offsets.entry(id.clone()).or_insert(usize::MAX);
            if *entry == usize::MAX {
                return;
            }
            let next = entry.saturating_add(lines);
            *entry = if next >= tail { usize::MAX } else { next };
        }
    }

    /// Scroll the review log panel up by `lines`.
    pub fn review_log_scroll_up(&mut self, lines: usize, total_logs: usize, inner_height: usize) {
        let tail = total_logs.saturating_sub(inner_height);
        if self.review_log_scroll_offset == usize::MAX {
            // Convert from tail-following to a real pinned position
            self.review_log_scroll_offset = tail.saturating_sub(lines);
        } else {
            self.review_log_scroll_offset = self.review_log_scroll_offset.saturating_sub(lines);
        }
    }

    /// Scroll the review log panel down by `lines`.
    pub fn review_log_scroll_down(&mut self, lines: usize, total_logs: usize, inner_height: usize) {
        let tail = total_logs.saturating_sub(inner_height);
        if self.review_log_scroll_offset == usize::MAX {
            return;
        }
        let next = self.review_log_scroll_offset.saturating_add(lines);
        self.review_log_scroll_offset = if next >= tail { usize::MAX } else { next };
    }

    pub fn dag_scroll_up(&mut self) {
        self.dag_scroll_offset = self.dag_scroll_offset.saturating_sub(1);
    }

    pub fn dag_scroll_down(&mut self, total_lines: u16, visible_height: u16) {
        let max = total_lines.saturating_sub(visible_height);
        if self.dag_scroll_offset < max {
            self.dag_scroll_offset += 1;
        }
    }

    pub fn dag_line_count(&self) -> u16 {
        if self.dag_levels.is_empty() {
            return 2; // empty line + waiting message
        }
        let mut count: u16 = 1; // initial empty line
        for (i, level) in self.dag_levels.iter().enumerate() {
            count += 3; // level header (top border, label, bottom border)
            for story_id in level {
                count += 1; // story line
                if let Some(story) = self.stories.iter().find(|s| s.id == *story_id) {
                    if story.error.is_some() {
                        count += 1; // error line
                    }
                }
            }
            if i < self.dag_levels.len() - 1 {
                count += 2; // connector + arrow
            }
            count += 1; // trailing empty line
        }
        count
    }

    pub fn dag_auto_scroll_to_story(&mut self, story_id: &str, visible_height: u16) {
        if self.dag_levels.is_empty() {
            return;
        }
        let mut line: u16 = 1; // initial empty line
        for (i, level) in self.dag_levels.iter().enumerate() {
            let level_start = line;
            line += 3; // level header
            for sid in level {
                if sid == story_id {
                    // Scroll so the level header is visible
                    if level_start < self.dag_scroll_offset {
                        self.dag_scroll_offset = level_start;
                    } else if line >= self.dag_scroll_offset + visible_height {
                        self.dag_scroll_offset = line.saturating_sub(visible_height) + 1;
                    }
                    return;
                }
                line += 1;
                if let Some(story) = self.stories.iter().find(|s| s.id == *sid) {
                    if story.error.is_some() {
                        line += 1;
                    }
                }
            }
            if i < self.dag_levels.len() - 1 {
                line += 2;
            }
            line += 1;
        }
    }

    pub fn auto_scroll_to_running(&mut self) {
        let mut index = 0;
        if self.dag_levels.is_empty() {
            for story in &self.stories {
                if story.status == StoryStatus::Running {
                    self.story_list_state.select(Some(index));
                    return;
                }
                index += 1;
            }
        } else {
            for (i, level) in self.dag_levels.iter().enumerate() {
                index += 1; // level header
                for story_id in level {
                    if let Some(story) = self.stories.iter().find(|s| s.id == *story_id) {
                        if story.status == StoryStatus::Running {
                            self.story_list_state.select(Some(index));
                            return;
                        }
                    }
                    index += 1;
                }
                if self.review_in_progress && self.review_level == i {
                    index += 1;
                }
                if i < self.dag_levels.len() - 1 {
                    index += 1;
                }
            }
        }
    }

    pub fn active_story_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.active_stories.keys().cloned().collect();
        ids.sort();
        ids
    }

    // Review screen navigation
    pub fn review_next(&mut self) {
        if !self.review_stories.is_empty() {
            self.review_scroll = (self.review_scroll + 1).min(self.review_stories.len() - 1);
            // ~4 lines per story entry; scroll down if selected story is below visible area
            let lines_per_story: u16 = 4;
            let visible_end = self.review_scroll_offset.saturating_add(20); // estimate ~20 visible lines
            let selected_bottom = (self.review_scroll as u16 + 1) * lines_per_story;
            if selected_bottom > visible_end {
                let max_offset = (self.review_stories.len() as u16).saturating_mul(lines_per_story).saturating_sub(20);
                self.review_scroll_offset = (self.review_scroll_offset + lines_per_story).min(max_offset);
            }
        }
    }

    pub fn review_prev(&mut self) {
        self.review_scroll = self.review_scroll.saturating_sub(1);
        // ~4 lines per story entry; scroll up if selected story is above visible area
        let lines_per_story: u16 = 4;
        let selected_top = self.review_scroll as u16 * lines_per_story;
        if selected_top < self.review_scroll_offset {
            self.review_scroll_offset = self.review_scroll_offset.saturating_sub(lines_per_story);
        }
    }

    pub fn handle_event(&mut self, event: BaroEvent) {
        match event {
            BaroEvent::Init { project, stories } => {
                self.project = project;
                self.total = stories.len() as u32;
                // On resume, review_stories was seeded from prd.json with
                // each story's `completed` flag. The orchestrator emits
                // Init with every story (not just incomplete ones) and
                // doesn't replay StoryComplete for prior-run finishes, so
                // without consulting review_stories here, already-done
                // stories render as Pending forever and the dashboard
                // counter starts at 0/N. Seed the initial status from
                // review_stories when available; on fresh runs that map
                // is empty and everything starts Pending as before.
                self.stories = stories
                    .into_iter()
                    .map(|s| {
                        let already_done = self
                            .review_stories
                            .iter()
                            .find(|r| r.id == s.id)
                            .map(|r| r.completed)
                            .unwrap_or(false);
                        StoryState {
                            id: s.id,
                            title: s.title,
                            depends_on: s.depends_on,
                            status: if already_done {
                                StoryStatus::Complete
                            } else {
                                StoryStatus::Pending
                            },
                            duration_secs: None,
                            error: None,
                            files_created: 0,
                            files_modified: 0,
                        }
                    })
                    .collect();
                self.start_time = Instant::now();
            }

            BaroEvent::Dag { levels } => {
                self.dag_levels = levels
                    .into_iter()
                    .map(|level| level.into_iter().map(|n| n.id).collect())
                    .collect();
            }

            BaroEvent::StoryStart { id, title } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.status = StoryStatus::Running;
                }
                self.active_stories.insert(
                    id.clone(),
                    ActiveStory {
                        id,
                        title,
                        logs: Vec::new(),
                        start_time: Instant::now(),
                    },
                );
            }

            BaroEvent::StoryLog { id, line } => {
                if let Some(active) = self.active_stories.get_mut(&id) {
                    active.logs.push(line);
                    if active.logs.len() > MAX_LOG_LINES {
                        active.logs.remove(0);
                    }
                }
                // Ensure entry exists; usize::MAX means "follow tail" (clamped at render)
                self.log_scroll_offsets.entry(id).or_insert(usize::MAX);
            }

            BaroEvent::StoryComplete {
                id,
                duration_secs,
                files_created,
                files_modified,
            } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.status = StoryStatus::Complete;
                    story.duration_secs = Some(duration_secs);
                    story.files_created = files_created;
                    story.files_modified = files_modified;
                } else {
                    // Resume mode: story was already complete before this run and is not in
                    // app.stories (Init only sends incomplete stories). Push a synthetic entry
                    // so duration_secs is preserved for the completion screen's sequential_time
                    // calculation (execute_completion.rs sums app.stories duration_secs).
                    self.stories.push(StoryState {
                        id: id.clone(),
                        title: id.clone(),
                        depends_on: Vec::new(),
                        status: StoryStatus::Complete,
                        duration_secs: Some(duration_secs),
                        error: None,
                        files_created,
                        files_modified,
                    });
                }
                self.active_stories.remove(&id);
                let count = self.active_stories.len();
                if count > 0 && self.selected_log_index >= count {
                    self.selected_log_index = count - 1;
                }
            }

            BaroEvent::StoryError {
                id,
                error,
                attempt,
                max_retries,
            } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    // A terminal error after exhausted retries is a true
                    // failure, not a "skipped" — the story actually ran
                    // (often for many minutes) and could not be made
                    // green. Show it as Failed so the user isn't told
                    // their work was just skipped past.
                    story.status = StoryStatus::Failed;
                    story.error = Some(error);
                    if attempt >= max_retries {
                        self.active_stories.remove(&id);
                    }
                }
            }

            BaroEvent::StoryRetry { id, attempt } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.status = StoryStatus::Retrying(attempt);
                }
            }

            BaroEvent::Progress {
                completed,
                total,
                percentage,
            } => {
                self.completed = completed;
                self.total = total;
                self.percentage = percentage;
            }

            BaroEvent::PushStatus { id, success, error } => {
                if let Some(active) = self.active_stories.get_mut(&id) {
                    if success {
                        active.logs.push(format!("[push] Successfully pushed {}", id));
                    } else {
                        active.logs.push(format!(
                            "[push] Failed to push {}: {}",
                            id,
                            error.as_deref().unwrap_or("unknown error")
                        ));
                    }
                }
                self.push_results.push((id, success, error));
            }

            BaroEvent::ReviewStart { level } => {
                self.review_in_progress = true;
                self.review_level = level;
                self.review_logs.clear();
            }

            BaroEvent::ReviewLog { line } => {
                self.review_logs.push(line);
            }

            BaroEvent::ReviewComplete { level, passed, fix_count } => {
                self.review_in_progress = false;
                self.review_logs.push(format!(
                    "Level {} review: {} ({})",
                    level,
                    if passed { "passed" } else { "fixes needed" },
                    fix_count,
                ));
            }

            BaroEvent::FinalizeStart => {
                self.finalize_in_progress = true;
                self.active_stories.insert(
                    "finalize".to_string(),
                    ActiveStory {
                        id: "finalize".to_string(),
                        title: "Finalizing".to_string(),
                        logs: Vec::new(),
                        start_time: Instant::now(),
                    },
                );
            }

            BaroEvent::FinalizeComplete { pr_url } => {
                self.finalize_in_progress = false;
                self.pr_url = pr_url;
            }

            BaroEvent::Done {
                total_time_secs,
                stats,
                success,
                abort_reason,
            } => {
                self.done = true;
                self.total_time_secs = total_time_secs;
                self.final_stats = Some(stats);
                if !success {
                    // Surface the run-level failure on the completion
                    // screen with the explicit reason instead of the
                    // green "ALL STORIES COMPLETE" banner.
                    self.exit_reason = Some(abort_reason.unwrap_or_else(|| {
                        "Run did not complete the goal.".to_string()
                    }));
                }
            }

            BaroEvent::NotificationReady => {
                self.notification_ready = true;
            }

            BaroEvent::TokenUsage { id, input_tokens, output_tokens } => {
                let entry = self.token_usage.entry(id).or_insert((0, 0));
                entry.0 += input_tokens;
                entry.1 += output_tokens;
                self.total_input_tokens += input_tokens;
                self.total_output_tokens += output_tokens;
            }

            BaroEvent::OrchestratorExited { code, reason } => {
                // If a normal `Done` event already arrived, this is just
                // a redundant terminator — keep the previous final state.
                if !self.done {
                    self.done = true;
                    self.finalize_in_progress = false;
                    if self.total_time_secs == 0 {
                        self.total_time_secs = self.elapsed_secs();
                    }
                    let msg = match (code, reason) {
                        (Some(0), _) => {
                            "Orchestrator exited without a final summary. \
                             Some stories may not have completed.".to_string()
                        }
                        (Some(c), Some(r)) => {
                            format!("Orchestrator exited (code {}): {}", c, r)
                        }
                        (Some(c), None) => {
                            format!("Orchestrator exited with code {}", c)
                        }
                        (None, Some(r)) => {
                            format!("Orchestrator terminated: {}", r)
                        }
                        (None, None) => {
                            "Orchestrator terminated unexpectedly.".to_string()
                        }
                    };
                    self.exit_reason = Some(msg);
                }
            }
        }
    }

    pub fn elapsed_secs(&self) -> u64 {
        if self.done {
            self.total_time_secs
        } else {
            self.start_time.elapsed().as_secs()
        }
    }

    pub fn model_for_phase(&self, phase: &str) -> Option<String> {
        // Global `--model` always wins.
        if let Some(ref model) = self.override_model {
            return Some(model.clone());
        }
        // Then per-phase explicit overrides (`--architect-model`, etc.).
        let per_phase = match phase {
            "architect" => self.architect_model.as_ref(),
            "planning" => self.planner_model.as_ref(),
            "execution" | "story" => self.story_model.as_ref(),
            _ => None,
        };
        if let Some(m) = per_phase {
            return Some(m.clone());
        }
        // Routed default — must match the provider. Claude phases
        // return Claude model names (`opus`, `haiku`); OpenAI
        // phases return gpt-5.x names. Returning a Claude name on
        // the OpenAI path (the pre-0.36.3 bug) made the TS planner
        // throw "unknown model 'opus'" before any inference.
        if self.model_routing {
            return match (self.llm, phase) {
                (LlmProvider::Claude, "architect" | "planning" | "execution" | "story") => {
                    Some("opus".to_string())
                }
                (LlmProvider::Claude, "review") => Some("haiku".to_string()),
                // Critic-style review work stays on mini — it's the
                // highest-volume call in a run and the verdict is a
                // structured PASS/FAIL that doesn't need flagship
                // reasoning. Everything else gets 5.5.
                (LlmProvider::OpenAI, "architect" | "planning" | "execution" | "story") => {
                    Some("gpt-5.5".to_string())
                }
                (LlmProvider::OpenAI, "review") => Some("gpt-5.4-mini".to_string()),
                // OpenCode: no hardcoded model — let it use whatever the
                // user configured in their opencode setup. Returning None
                // means the TS side passes no --model flag and opencode
                // picks its own default provider + model.
                (LlmProvider::OpenCode, _) => None,
                // Copilot: no hardcoded model — let it use its own default
                // (`claude-sonnet-4.5`). Returning None means the TS side
                // passes no --model flag.
                (LlmProvider::Copilot, _) => None,
                _ => None,
            };
        }
        None
    }
}
