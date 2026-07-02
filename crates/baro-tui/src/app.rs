use std::collections::HashMap;
use std::time::Instant;

use ratatui::widgets::ListState;

use crate::events::{BaroEvent, DoneStats};

use crate::constants::MAX_LOG_LINES;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Screen {
    /// First step when invoked without a goal: pick the backend for
    /// every LLM-using phase.
    ProviderPicker,
    /// Shown only for the OpenAI backend when `OPENAI_API_KEY` isn't
    /// set. Held in memory only; never written to disk.
    ApiKeyInput,
    /// Interactive confirm/override of the intake's proposed execution
    /// mode (`--mode auto` only); sits between Architect and Planner.
    ModePicker,
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
    Pi,
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
    Changes,
}

impl GlobalTab {
    pub fn next(self) -> Self {
        match self {
            Self::Dashboard => Self::Dag,
            Self::Dag => Self::Stats,
            Self::Stats => Self::Changes,
            Self::Changes => Self::Dashboard,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Dashboard => Self::Changes,
            Self::Dag => Self::Dashboard,
            Self::Stats => Self::Dag,
            Self::Changes => Self::Stats,
        }
    }

    pub fn index(self) -> usize {
        match self {
            Self::Dashboard => 0,
            Self::Dag => 1,
            Self::Stats => 2,
            Self::Changes => 3,
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
    /// without an authoritative spec.
    Skipped(String),
}

/// Which backend every phase routes its calls to; selected via `--llm`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmProvider {
    Claude,
    OpenAI,
    /// OpenAI Codex CLI subprocess — ChatGPT-subscription billing,
    /// one-shot non-interactive invocation per turn.
    Codex,
    /// OpenCode CLI subprocess (`opencode run --format json`); any
    /// model via `-m provider/model`.
    OpenCode,
    /// Pi CLI subprocess, similar to OpenCode.
    Pi,
}

impl LlmProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::OpenAI => "openai",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "claude" => Some(Self::Claude),
            "openai" => Some(Self::OpenAI),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::OpenCode),
            "pi" => Some(Self::Pi),
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
    /// Never constructed — terminal retry-exhaustion uses `Failed` so
    /// attempted work isn't reported as "skipped". Kept for an upcoming
    /// `story_dropped` event.
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

/// One condensed, typed entry in the structured Activity feed (replaces the
/// raw `logs` firehose for rendering). `text` is the ready-to-show summary;
/// `kind`/`tool`/`op`/`ok` drive the color + icon.
#[derive(Debug, Clone)]
pub struct ActivityEntry {
    pub kind: String,
    pub text: String,
    pub tool: Option<String>,
    pub op: Option<String>,
    pub ok: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ActiveStory {
    pub id: String,
    pub title: String,
    pub logs: Vec<String>,
    pub activity: Vec<ActivityEntry>,
    pub start_time: Instant,
}

/// Order matches the ModePicker screen rows.
pub const MODE_OPTIONS: [&str; 3] = ["focused", "sequential", "parallel"];

/// Intake's proposed execution mode, parsed for display; the raw
/// contract JSON is kept verbatim so confirming the proposal forwards
/// exactly what the intake produced.
#[derive(Debug, Clone)]
pub struct ModeProposal {
    pub mode: String,
    pub reason: String,
    pub confidence: f64,
    pub contract_json: String,
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

    pub provider_picker_index: usize,
    /// Claude and OpenAI are always present; Codex/OpenCode/Pi are
    /// added when their CLI is detected on PATH.
    pub provider_picker_options: Vec<LlmProvider>,

    /// In-progress text buffer; the confirmed key lives in
    /// `openai_api_key`, passed via env and never written to disk.
    pub api_key_input: String,
    pub openai_api_key: Option<String>,
    /// Custom base URL for OpenAI-compatible endpoints
    /// (`--openai-base-url` / `OPENAI_BASE_URL`).
    pub openai_base_url: Option<String>,
    /// Effort level for spawned `claude` processes (`--effort`).
    pub effort: String,

    // Welcome screen
    pub goal_input: String,
    pub welcome_field: WelcomeField,

    // Context building screen
    pub claude_md_content: Option<String>,
    /// Architect's DecisionDocument, held until write_prd persists it
    /// into prd.json for the orchestrator to prepend to story prompts.
    pub decision_document: Option<String>,
    pub architect_status: ArchitectStatus,

    // Planning screen
    pub planning_start: Option<Instant>,
    pub planning_error: Option<String>,
    /// Persisted log path for a failed planner/architect run, surfaced
    /// on the planning screen.
    pub planning_log_path: Option<std::path::PathBuf>,

    // Review screen
    pub branch_name: String,
    pub description: String,
    pub review_stories: Vec<ReviewStory>,
    pub review_scroll: usize,
    pub review_scroll_offset: u16,

    // Execute screen
    pub project: String,
    /// Where the run executes (hostname for local CLI); shown in the status bar.
    pub runner: Option<String>,
    /// Files changed across all merged stories (path + add/remove counts).
    pub changed_files: Vec<crate::events::DiffFile>,
    /// Per-story capped unified diff text, for the Changes view.
    pub story_diffs: HashMap<String, String>,
    /// Per-run cost in USD, summed from backends that report it (Claude CLI).
    pub total_cost_usd: f64,
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
    /// Set when the orchestrator terminated without a normal `Done`
    /// event; the completion screen surfaces the unclean finish.
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
    /// When `Some`, the post-run follow-up prompt is open and this is the buffer.
    pub followup_input: Option<String>,
    /// Set when the current run is a follow-up (continue on the existing branch/PR);
    /// the Review→Execute path then stays on the current branch instead of creating one.
    pub is_followup: bool,
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
    /// Per-phase model overrides; beaten only by the global
    /// `override_model`. The Critic + Surgeon fields above predate
    /// this group and stay separate.
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

    /// Quick mode (`--quick`): skip the Architect, plan exactly one
    /// story, disable Critic + Surgeon.
    pub quick: bool,

    /// `--mode` / `BARO_MODE`: "auto" runs intake (+ picker in the TUI);
    /// anything else forces that mode and skips both.
    pub mode: String,
    pub mode_picker_index: usize,
    pub mode_proposal: Option<ModeProposal>,
    /// Planner-stamped `executionMode` contract, passed through opaquely
    /// so it survives into prd.json for the orchestrator.
    pub execution_mode: Option<serde_json::Value>,

    /// The default backend every phase uses unless a per-phase
    /// override is set.
    pub llm: LlmProvider,
    /// Per-phase overrides; each defaults to `llm`. `--llm hybrid`
    /// flips Story + Critic to Codex.
    pub architect_llm: LlmProvider,
    pub planner_llm: LlmProvider,
    pub story_llm: LlmProvider,
    pub critic_llm: LlmProvider,
    pub surgeon_llm: LlmProvider,
    /// True when `--llm` was passed explicitly (any value). The picker
    /// keys on this, not `llm != Claude` — hybrid and explicit
    /// `--llm claude` both resolve to Claude.
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
                if which::which("pi").is_ok() {
                    opts.push(LlmProvider::Pi);
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
            followup_input: None,
            is_followup: false,
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
            quick: false,
            mode: "auto".to_string(),
            mode_picker_index: 0,
            mode_proposal: None,
            execution_mode: None,
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
            runner: None,
            changed_files: Vec::new(),
            story_diffs: HashMap::new(),
            total_cost_usd: 0.0,
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
        self.changed_files.clear();
        self.story_diffs.clear();
        self.total_cost_usd = 0.0;
        self.stories.clear();
    }

    pub fn planning_elapsed_secs(&self) -> u64 {
        self.planning_start
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0)
    }

    // Cycles the Welcome-screen backend radio AND propagates it into the
    // routing fields — execution routes off `llm`/`*_llm`, not the legacy
    // `planner` enum, so mutating `planner` alone left the radio cosmetic.
    pub fn toggle_planner(&mut self) {
        self.planner = match self.planner {
            Planner::Claude => Planner::OpenAI,
            Planner::OpenAI => Planner::Codex,
            Planner::Codex => Planner::OpenCode,
            Planner::OpenCode => Planner::Pi,
            Planner::Pi => Planner::Claude,
        };
        let provider = match self.planner {
            Planner::Claude => LlmProvider::Claude,
            Planner::OpenAI => LlmProvider::OpenAI,
            Planner::Codex => LlmProvider::Codex,
            Planner::OpenCode => LlmProvider::OpenCode,
            Planner::Pi => LlmProvider::Pi,
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
            BaroEvent::Init { project, stories, runner } => {
                self.project = project;
                self.runner = runner;
                self.total = stories.len() as u32;
                // On resume the orchestrator emits Init with every story
                // but doesn't replay StoryComplete for prior-run finishes —
                // seed status from review_stories (prd.json's `completed`)
                // or already-done stories render Pending forever.
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
                        activity: Vec::new(),
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

            BaroEvent::Activity { id, kind, text, tool, op, ok } => {
                if let Some(active) = self.active_stories.get_mut(&id) {
                    active.activity.push(ActivityEntry { kind, text, tool, op, ok });
                    if active.activity.len() > MAX_LOG_LINES {
                        active.activity.remove(0);
                    }
                }
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
                    // Resume: the story finished in a prior run and isn't in
                    // app.stories — push a synthetic entry so duration_secs
                    // feeds the completion screen's sequential-time sum.
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
                    // Retry exhaustion is a true failure — the story ran and
                    // couldn't be made green — so Failed, not "skipped".
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
                        activity: Vec::new(),
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
                    // Show the explicit failure reason instead of the
                    // green completion banner.
                    self.exit_reason = Some(abort_reason.unwrap_or_else(|| {
                        "Run did not complete the goal.".to_string()
                    }));
                }
            }

            BaroEvent::NotificationReady => {
                self.notification_ready = true;
            }

            BaroEvent::TokenUsage { id, input_tokens, output_tokens, cost_usd } => {
                let entry = self.token_usage.entry(id).or_insert((0, 0));
                entry.0 += input_tokens;
                entry.1 += output_tokens;
                self.total_input_tokens += input_tokens;
                self.total_output_tokens += output_tokens;
                if let Some(c) = cost_usd {
                    self.total_cost_usd += c;
                }
            }

            BaroEvent::StoryDiff { id, files, diff } => {
                // Merge file stats into the run-wide changed-files list (dedup
                // by path, accumulating counts), and keep the per-story diff.
                for f in files {
                    if let Some(existing) =
                        self.changed_files.iter_mut().find(|e| e.path == f.path)
                    {
                        existing.added += f.added;
                        existing.removed += f.removed;
                    } else {
                        self.changed_files.push(f);
                    }
                }
                if let Some(text) = diff {
                    self.story_diffs.insert(id, text);
                }
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
        // Routed defaults must match the provider — returning a Claude
        // name on the OpenAI path once made the TS planner throw
        // "unknown model 'opus'" before any inference.
        if self.model_routing {
            return match (self.llm, phase) {
                (LlmProvider::Claude, "architect" | "planning" | "execution" | "story") => {
                    Some("opus".to_string())
                }
                (LlmProvider::Claude, "review") => Some("haiku".to_string()),
                // Review stays on mini — highest-volume call, structured
                // PASS/FAIL verdict that doesn't need flagship reasoning.
                (LlmProvider::OpenAI, "architect" | "planning" | "execution" | "story") => {
                    Some("gpt-5.5".to_string())
                }
                (LlmProvider::OpenAI, "review") => Some("gpt-5.4-mini".to_string()),
                // OpenCode/Pi: None → the TS side passes no --model and
                // the CLI uses the user's own configured default.
                (LlmProvider::OpenCode, _) => None,
                (LlmProvider::Pi, _) => None,
                _ => None,
            };
        }
        None
    }
}
