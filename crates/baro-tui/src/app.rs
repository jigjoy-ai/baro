use std::collections::HashMap;
use std::time::Instant;

use ratatui::widgets::ListState;

use crate::events::{BaroEvent, DoneStats, RunVerificationEvidence};

use crate::constants::MAX_LOG_LINES;
use crate::dag_state::rebuild_dag_levels;

pub const DIALOGUE_AGENT_ID: &str = "_dialogue";

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

/// What the workbench main pane shows. Number keys keep the historical
/// tab mapping (1 activity, 2 plan, 3 stats, 4 diff) for muscle memory;
/// Decisions is reachable via `5` or Left/Right cycling.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MainView {
    Activity,
    Plan,
    Stats,
    Diff,
    Decisions,
}

impl MainView {
    pub fn next(self) -> Self {
        match self {
            Self::Activity => Self::Plan,
            Self::Plan => Self::Stats,
            Self::Stats => Self::Diff,
            Self::Diff => Self::Decisions,
            Self::Decisions => Self::Activity,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Activity => Self::Decisions,
            Self::Plan => Self::Activity,
            Self::Stats => Self::Plan,
            Self::Diff => Self::Stats,
            Self::Decisions => Self::Diff,
        }
    }
}

/// Keyboard focus zone; Tab cycles Main → Agents → Changes when the
/// explorer is visible.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WorkbenchFocus {
    Main,
    Agents,
    Changes,
}

impl WorkbenchFocus {
    pub fn next(self) -> Self {
        match self {
            Self::Main => Self::Agents,
            Self::Agents => Self::Changes,
            Self::Changes => Self::Main,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Main => Self::Changes,
            Self::Agents => Self::Main,
            Self::Changes => Self::Agents,
        }
    }
}

pub const EXPLORER_MIN_WIDTH: u16 = 20;
pub const EXPLORER_MAX_WIDTH: u16 = 45;
pub const EXPLORER_DEFAULT_WIDTH: u16 = 30;

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

/// How a replan touched a story (for the ✂ pill + DAG marks).
#[derive(Debug, Clone, PartialEq)]
pub enum ReplanMark {
    Added,
    Removed(String),
}

/// Level lifecycle from level_started/level_completed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LevelRunState {
    Running,
    Done { failed: bool },
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
    /// Highest retry attempt seen; survives the Retrying→Running transition
    /// so the ↻n pill persists.
    pub retry_count: u32,
    /// Last critic verdict (`critique` event); None until the critic speaks.
    pub critic_pass: Option<bool>,
    /// Supervisor intervention action (e.g. "aborted") when one fired.
    pub intervened: Option<String>,
    /// Some(true) merged, Some(false) merge failed (worktree preserved).
    pub merge: Option<bool>,
    pub replan: Option<ReplanMark>,
    /// Routed "backend:model" lane from the `routed` event.
    pub route: Option<String>,
}

impl StoryState {
    pub fn new(id: String, title: String, depends_on: Vec<String>, status: StoryStatus) -> Self {
        Self {
            id,
            title,
            depends_on,
            status,
            duration_secs: None,
            error: None,
            files_created: 0,
            files_modified: 0,
            retry_count: 0,
            critic_pass: None,
            intervened: None,
            merge: None,
            replan: None,
            route: None,
        }
    }
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
    /// Run-machinery event (replan/intervention/recovery/merge) rather than
    /// agent output — rendered with a distinct ▸ accent prefix.
    pub system: bool,
}

impl ActivityEntry {
    fn system(kind: &str, text: String) -> Self {
        Self {
            kind: kind.to_string(),
            text,
            tool: None,
            op: None,
            ok: None,
            system: true,
        }
    }
}

/// Keyed by story id in `App::active_stories`.
#[derive(Debug, Clone)]
pub struct ActiveStory {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewStory {
    pub id: String,
    pub priority: i32,
    pub title: String,
    pub description: String,
    pub depends_on: Vec<String>,
    pub retries: u32,
    pub acceptance: Vec<String>,
    pub tests: Vec<String>,
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
    /// Latest exploration/progress line streamed from the planner or
    /// architect subprocess, shown live on the planning screen.
    pub planning_progress: Option<String>,

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
    /// Resolved execution mode from `init` (focused/sequential/parallel);
    /// distinct from the `--mode` config knob below.
    pub run_mode: Option<String>,
    /// Level ordinal → lifecycle, from level_started/level_completed.
    pub level_states: HashMap<usize, LevelRunState>,
    /// Recovery levels: (attempt, story ids), in start order.
    pub recoveries: Vec<(u32, Vec<String>)>,
    pub active_stories: HashMap<String, ActiveStory>,
    pub completed: u32,
    pub total: u32,
    pub percentage: u32,
    pub start_time: Instant,
    pub done: bool,
    pub final_stats: Option<DoneStats>,
    pub total_time_secs: u64,
    /// Objective run verification: passed, failed, or skipped/unverified.
    pub verification_status: Option<String>,
    /// Correlated commands and timings behind the objective verdict.
    pub verification: Option<RunVerificationEvidence>,
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
    /// `--confirm-mode`: headless emits the proposed mode and waits for a
    /// confirm_mode command before planning (opt-in; default fire-and-forget).
    pub confirm_mode: bool,
    pub mode_picker_index: usize,
    pub mode_proposal: Option<ModeProposal>,
    /// Planner-stamped `executionMode` contract, passed through opaquely
    /// so it survives into prd.json for the orchestrator.
    pub execution_mode: Option<serde_json::Value>,

    /// The default backend every phase uses unless a per-phase
    /// override is set.
    pub llm: LlmProvider,
    /// Per-phase overrides; each defaults to `llm`. `--llm hybrid`
    /// flips Story to Codex while keeping Critic on tool-less Claude.
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
    /// Latest non-authoritative live snapshot per running agent.
    pub live_token_usage: HashMap<String, (u64, u64)>,

    // UI state
    pub main_view: MainView,
    pub selected_log_index: usize,
    pub tick_count: u64,
    pub story_list_state: ListState,
    pub dag_scroll_offset: u16,
    pub log_scroll_offsets: HashMap<String, usize>,
    pub review_log_scroll_offset: usize,

    // Workbench state
    pub focus: WorkbenchFocus,
    pub explorer_visible: bool,
    pub explorer_width: u16,
    /// Explorer Changes selection (index into `changed_files`).
    pub explorer_file_ix: usize,
    /// When Some, the activity view is pinned to this story instead of
    /// following the active-agent tab strip.
    pub activity_filter: Option<String>,
    pub diff_scroll_offset: u16,
    /// File the diff view should scroll to; applied at render (only there
    /// is the composed diff's line layout known), then the flag clears.
    pub diff_target: Option<String>,
    pub diff_scroll_pending: bool,
    pub decisions_scroll: u16,
    /// Mid-run chat input: (target story id, buffer). Rendered in the
    /// bottom strip; Enter sends an agent or collective dialogue command.
    pub agent_msg_input: Option<(String, String)>,
    /// The opt-in communication-only collective participant is available.
    pub dialogue_enabled: bool,
    /// Live orchestrator stdin (JSON command lines); refreshed per spawn.
    pub orchestrator_stdin: Option<tokio::sync::mpsc::Sender<String>>,
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
            planning_progress: None,

            branch_name: String::new(),
            description: String::new(),
            review_stories: Vec::new(),
            review_scroll: 0,
            review_scroll_offset: 0,

            project: String::new(),
            stories: Vec::new(),
            dag_levels: Vec::new(),
            run_mode: None,
            level_states: HashMap::new(),
            recoveries: Vec::new(),
            active_stories: HashMap::new(),
            completed: 0,
            total: 0,
            percentage: 0,
            start_time: Instant::now(),
            done: false,
            final_stats: None,
            total_time_secs: 0,
            verification_status: None,
            verification: None,
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
            confirm_mode: false,
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
            live_token_usage: HashMap::new(),
            runner: None,
            changed_files: Vec::new(),
            story_diffs: HashMap::new(),
            total_cost_usd: 0.0,
            main_view: MainView::Activity,
            selected_log_index: 0,
            tick_count: 0,
            story_list_state: ListState::default(),
            dag_scroll_offset: 0,
            log_scroll_offsets: HashMap::new(),
            review_log_scroll_offset: usize::MAX,
            focus: WorkbenchFocus::Main,
            explorer_visible: true,
            explorer_width: EXPLORER_DEFAULT_WIDTH,
            explorer_file_ix: 0,
            activity_filter: None,
            diff_scroll_offset: 0,
            diff_target: None,
            diff_scroll_pending: false,
            decisions_scroll: 0,
            agent_msg_input: None,
            dialogue_enabled: std::env::var("BARO_WITH_DIALOGUE")
                .is_ok_and(|value| value == "1"),
            orchestrator_stdin: None,
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
        self.planning_progress = None;
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
        self.agent_msg_input = None;
        self.selected_log_index = 0;
        self.completed = 0;
        self.percentage = 0;
        self.final_stats = None;
        self.done = false;
        self.verification_status = None;
        self.verification = None;
        self.exit_reason = None;
        self.finalize_in_progress = false;
        self.pr_url = None;
        self.push_results.clear();
        self.token_usage.clear();
        self.total_input_tokens = 0;
        self.total_output_tokens = 0;
        self.live_token_usage.clear();
        self.changed_files.clear();
        self.story_diffs.clear();
        self.total_cost_usd = 0.0;
        self.stories.clear();
        self.level_states.clear();
        self.recoveries.clear();
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

    pub fn next_view(&mut self) {
        self.main_view = self.main_view.next();
    }

    pub fn prev_view(&mut self) {
        self.main_view = self.main_view.prev();
    }

    pub fn explorer_wider(&mut self) {
        self.explorer_width = (self.explorer_width + 2).min(EXPLORER_MAX_WIDTH);
    }

    pub fn explorer_narrower(&mut self) {
        self.explorer_width = self.explorer_width.saturating_sub(2).max(EXPLORER_MIN_WIDTH);
    }

    /// Selectable story ids in the exact item order of the explorer Agents
    /// list (None = level header / spinner / connector row). Must stay in
    /// sync with the explorer's item layout — both key handling and
    /// auto_scroll_to_running index through this.
    pub fn agent_item_rows(&self) -> Vec<Option<String>> {
        let mut rows: Vec<Option<String>> = Vec::new();
        if self.dag_levels.is_empty() {
            for s in &self.stories {
                rows.push(Some(s.id.clone()));
            }
        } else {
            for (i, level) in self.dag_levels.iter().enumerate() {
                rows.push(None); // level header
                for sid in level {
                    if self.stories.iter().any(|s| s.id == *sid) {
                        rows.push(Some(sid.clone()));
                    }
                }
                if self.review_in_progress && self.review_level == i {
                    rows.push(None); // review spinner
                }
                if i < self.dag_levels.len() - 1 {
                    rows.push(None); // connector
                }
            }
        }
        rows
    }

    /// Move the Agents selection to the previous/next story row, pinning
    /// the activity view to that agent.
    pub fn explorer_agents_move(&mut self, delta: i64) {
        let rows = self.agent_item_rows();
        if rows.is_empty() {
            return;
        }
        let cur = self
            .story_list_state
            .selected()
            .map(|ix| ix.min(rows.len() - 1) as i64)
            // No selection yet: enter from the edge the user is moving away from.
            .unwrap_or(if delta > 0 { -1 } else { rows.len() as i64 });
        let mut ix = cur + delta;
        while ix >= 0 && (ix as usize) < rows.len() {
            if let Some(id) = &rows[ix as usize] {
                self.story_list_state.select(Some(ix as usize));
                self.activity_filter = Some(id.clone());
                self.main_view = MainView::Activity;
                return;
            }
            ix += delta;
        }
    }

    /// Story id currently selected in the explorer Agents section.
    pub fn selected_agent_id(&self) -> Option<String> {
        let rows = self.agent_item_rows();
        self.story_list_state
            .selected()
            .and_then(|ix| rows.get(ix).cloned())
            .flatten()
    }

    /// Target for a mid-run agent message: the explorer-selected agent when
    /// the Agents section has focus, else the pinned agent, else the
    /// tab-selected active story. Only *running* agents can receive one.
    pub fn message_target(&self) -> Option<String> {
        let candidate = if self.focus == WorkbenchFocus::Agents {
            self.selected_agent_id()
        } else {
            None
        }
        .or_else(|| self.activity_filter.clone())
        .or_else(|| self.active_story_ids().get(self.selected_log_index).cloned());
        candidate.filter(|id| {
            id != DIALOGUE_AGENT_ID && self.active_stories.contains_key(id)
        })
    }

    /// Open the global collective conversation without making it part of the
    /// control plane. The synthetic activity lane is UI-only.
    pub fn open_dialogue(&mut self) {
        if !self.dialogue_enabled {
            return;
        }
        self.active_stories
            .entry(DIALOGUE_AGENT_ID.to_string())
            .or_insert_with(|| ActiveStory {
                title: "Collective".to_string(),
                logs: Vec::new(),
                activity: Vec::new(),
                start_time: Instant::now(),
            });
        self.activity_filter = Some(DIALOGUE_AGENT_ID.to_string());
        self.main_view = MainView::Activity;
        self.focus = WorkbenchFocus::Main;
        self.agent_msg_input = Some((DIALOGUE_AGENT_ID.to_string(), String::new()));
    }

    /// Local echo of a user→agent message so it shows in the feed
    /// immediately, before (and regardless of) orchestrator round-trip.
    pub fn echo_user_message(&mut self, id: &str, text: &str) {
        let target = if id == DIALOGUE_AGENT_ID {
            "collective"
        } else {
            id
        };
        self.push_story_activity(
            id,
            ActivityEntry {
                kind: "user".to_string(),
                text: format!("you → {}: {}", target, text),
                tool: None,
                op: None,
                ok: None,
                system: false,
            },
        );
    }

    /// Move the Changes selection and point the diff view at that file.
    pub fn explorer_files_move(&mut self, delta: i64) {
        if self.changed_files.is_empty() {
            return;
        }
        let max = self.changed_files.len() - 1;
        let ix = (self.explorer_file_ix as i64 + delta).clamp(0, max as i64) as usize;
        self.explorer_file_ix = ix;
        self.diff_target = Some(self.changed_files[ix].path.clone());
        self.diff_scroll_pending = true;
        self.main_view = MainView::Diff;
    }

    pub fn diff_scroll_up(&mut self) {
        self.diff_scroll_offset = self.diff_scroll_offset.saturating_sub(1);
        self.diff_scroll_pending = false;
    }

    /// Upper bound is clamped at render time (only there is the composed
    /// diff's total line count known).
    pub fn diff_scroll_down(&mut self) {
        self.diff_scroll_offset = self.diff_scroll_offset.saturating_add(1);
        self.diff_scroll_pending = false;
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

    /// Story whose feed the activity view is showing: the explorer-pinned
    /// filter wins, otherwise the tab-selected active story.
    pub fn activity_story_id(&self) -> Option<String> {
        self.activity_filter
            .clone()
            .or_else(|| self.active_story_ids().get(self.selected_log_index).cloned())
    }

    /// Scroll the shown story's log panel up by `lines`. Pins position (stops auto-scroll).
    pub fn log_scroll_up(&mut self, lines: usize, total_logs: usize, inner_height: usize) {
        let tail = total_logs.saturating_sub(inner_height);
        if let Some(id) = self.activity_story_id() {
            let entry = self.log_scroll_offsets.entry(id).or_insert(usize::MAX);
            if *entry == usize::MAX {
                *entry = tail.saturating_sub(lines);
            } else {
                *entry = entry.saturating_sub(lines);
            }
        }
    }

    /// Scroll the shown story's log panel down by `lines`. Returns to tail (auto-scroll) at MAX.
    pub fn log_scroll_down(&mut self, lines: usize, total_logs: usize, inner_height: usize) {
        if let Some(id) = self.activity_story_id() {
            let tail = total_logs.saturating_sub(inner_height);
            let entry = self.log_scroll_offsets.entry(id).or_insert(usize::MAX);
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
        // Recovery sections mirror the level layout: 3-line header + one
        // line per story + trailing empty line (no error sub-lines).
        for (_, ids) in &self.recoveries {
            count += 3 + ids.len() as u16 + 1;
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
        // Don't yank the selection out from under a user navigating the
        // Agents explorer.
        if self.focus == WorkbenchFocus::Agents {
            return;
        }
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

    /// Append a system entry to one story's feed, if that story is active.
    fn push_story_activity(&mut self, id: &str, entry: ActivityEntry) {
        if let Some(active) = self.active_stories.get_mut(id) {
            active.activity.push(entry);
            if active.activity.len() > MAX_LOG_LINES {
                active.activity.remove(0);
            }
        }
    }

    /// Append a run-level system entry to every active feed so it shows up
    /// regardless of which agent tab is selected.
    fn push_run_activity(&mut self, entry: ActivityEntry) {
        for active in self.active_stories.values_mut() {
            active.activity.push(entry.clone());
            if active.activity.len() > MAX_LOG_LINES {
                active.activity.remove(0);
            }
        }
    }

    pub fn handle_event(&mut self, event: BaroEvent) {
        match event {
            BaroEvent::Init { project, stories, runner, mode } => {
                self.project = project;
                self.runner = runner;
                self.run_mode = mode;
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
                        StoryState::new(
                            s.id,
                            s.title,
                            s.depends_on,
                            if already_done {
                                StoryStatus::Complete
                            } else {
                                StoryStatus::Pending
                            },
                        )
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
                    id,
                    ActiveStory {
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

            BaroEvent::Activity { id, kind, text, tool, path: _, op, ok } => {
                if let Some(active) = self.active_stories.get_mut(&id) {
                    active.activity.push(ActivityEntry { kind, text, tool, op, ok, system: false });
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
                    let mut s = StoryState::new(
                        id.clone(),
                        id.clone(),
                        Vec::new(),
                        StoryStatus::Complete,
                    );
                    s.duration_secs = Some(duration_secs);
                    s.files_created = files_created;
                    s.files_modified = files_modified;
                    self.stories.push(s);
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
                    story.retry_count = story.retry_count.max(attempt);
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
                verification_status,
                verification,
            } => {
                self.done = true;
                self.total_time_secs = total_time_secs;
                self.final_stats = Some(stats);
                let embedded_status = verification
                    .as_ref()
                    .map(|evidence| evidence.status.clone());
                let status_mismatch = embedded_status.is_some()
                    && verification_status.is_some()
                    && embedded_status != verification_status;
                let candidate_status = embedded_status.or(verification_status);
                self.verification_status = match candidate_status.as_deref() {
                    Some("passed" | "failed" | "skipped") => candidate_status,
                    Some(other) => {
                        self.exit_reason = Some(format!(
                            "Invalid objective verification status: {}",
                            other,
                        ));
                        Some("failed".to_string())
                    }
                    None => None,
                };
                self.verification = verification;
                if status_mismatch {
                    self.verification_status = Some("failed".to_string());
                    self.exit_reason = Some(
                        "Inconsistent objective verification evidence received.".to_string(),
                    );
                }
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

            BaroEvent::ModelUsage { measurement: _ } => {
                // Parsed deliberately so structured telemetry never becomes a
                // noisy [parse-skip] line. TokenUsage remains the compatibility
                // projection used for the current totals UI.
            }

            BaroEvent::TokenProgress {
                id,
                input_tokens,
                output_tokens,
            } => {
                // Live snapshots are not deltas and therefore must not be
                // added to the authoritative final totals.
                self.live_token_usage
                    .insert(id, (input_tokens, output_tokens));
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

            BaroEvent::Replan { source, reason, added, removed, rewired } => {
                for a in added {
                    if let Some(existing) = self.stories.iter_mut().find(|s| s.id == a.id) {
                        existing.title = a.title;
                        existing.replan = Some(ReplanMark::Added);
                        existing.depends_on = a.depends_on;
                        if existing.status == StoryStatus::Skipped {
                            existing.status = StoryStatus::Pending;
                        }
                    } else {
                        let mut s = StoryState::new(
                            a.id,
                            a.title,
                            a.depends_on,
                            StoryStatus::Pending,
                        );
                        s.replan = Some(ReplanMark::Added);
                        self.stories.push(s);
                    }
                }
                for id in removed {
                    if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                        story.replan = Some(ReplanMark::Removed(reason.clone()));
                        if story.status != StoryStatus::Complete {
                            story.status = StoryStatus::Skipped;
                        }
                    }
                    self.active_stories.remove(&id);
                }
                for r in rewired {
                    if let Some(story) = self.stories.iter_mut().find(|s| s.id == r.id) {
                        story.depends_on = r.depends_on;
                    }
                }
                // Removed stories remain visible as struck/skipped history but
                // are no longer part of the live work denominator. Progress
                // events and this projection therefore agree regardless of
                // which observer's stdout event arrives first.
                self.total = self
                    .stories
                    .iter()
                    .filter(|story| story.status != StoryStatus::Skipped)
                    .count() as u32;
                if let Some(levels) = rebuild_dag_levels(&self.stories) {
                    self.dag_levels = levels;
                }
                self.push_run_activity(ActivityEntry::system(
                    "replan",
                    format!("replan ({}): {}", source, reason),
                ));
            }

            BaroEvent::Intervention { id, source, action, reason } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.intervened = Some(action.clone());
                }
                self.push_story_activity(
                    &id,
                    ActivityEntry::system(
                        "warn",
                        format!("intervention ({}): {} — {}", source, action, reason),
                    ),
                );
            }

            BaroEvent::StoryMerged { id, mode } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.merge = Some(true);
                }
                self.push_run_activity(ActivityEntry::system(
                    "merge",
                    format!("{} merged ({})", id, mode),
                ));
            }

            BaroEvent::MergeFailed { id, error } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.merge = Some(false);
                }
                self.push_run_activity(ActivityEntry::system(
                    "error",
                    format!("{} merge failed: {}", id, error),
                ));
            }

            BaroEvent::LevelStarted { ordinal, story_ids: _ } => {
                self.level_states.insert(ordinal, LevelRunState::Running);
            }

            BaroEvent::LevelCompleted { ordinal, passed: _, failed } => {
                self.level_states
                    .insert(ordinal, LevelRunState::Done { failed: !failed.is_empty() });
            }

            BaroEvent::RecoveryStarted { attempt, story_ids } => {
                self.push_run_activity(ActivityEntry::system(
                    "recovery",
                    format!("recovery attempt {} — {}", attempt, story_ids.join(", ")),
                ));
                self.recoveries.push((attempt, story_ids));
            }

            BaroEvent::Routed { id, backend, model } => {
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.route = Some(format!("{}:{}", backend, model));
                }
            }

            BaroEvent::Critique { id, verdict, reasoning, violated } => {
                let pass = verdict == "pass";
                if let Some(story) = self.stories.iter_mut().find(|s| s.id == id) {
                    story.critic_pass = Some(pass);
                }
                let text = if pass {
                    "critic: pass".to_string()
                } else if violated.is_empty() {
                    format!("critic: fail — {}", reasoning)
                } else {
                    format!("critic: fail — {} (violated: {})", reasoning, violated.join(", "))
                };
                let mut entry = ActivityEntry::system("verdict", text);
                entry.ok = Some(pass);
                self.push_story_activity(&id, entry);
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

    #[cfg(test)]
    fn story(&self, id: &str) -> &StoryState {
        self.stories.iter().find(|s| s.id == id).unwrap()
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
        let provider = match phase {
            "architect" => self.architect_llm,
            "planning" => self.planner_llm,
            "execution" | "story" => self.story_llm,
            "review" => self.critic_llm,
            _ => self.llm,
        };
        // Routed defaults must match the provider — returning a Claude
        // name on the OpenAI path once made the TS planner throw
        // "unknown model 'opus'" before any inference.
        if self.model_routing {
            return match (provider, phase) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(app: &mut App, json: &str) {
        app.handle_event(serde_json::from_str(json).expect(json));
    }

    fn app_with_run() -> App {
        let mut app = App::new();
        feed(
            &mut app,
            r#"{"type":"init","project":"p","mode":"focused",
                "stories":[{"id":"S1","title":"One"},{"id":"S2","title":"Two","depends_on":["S1"]}]}"#,
        );
        feed(&mut app, r#"{"type":"story_start","id":"S1","title":"One"}"#);
        app
    }

    #[test]
    fn routed_model_defaults_follow_each_phase_backend() {
        let mut app = App::new();
        app.llm = LlmProvider::OpenAI;
        app.architect_llm = LlmProvider::Claude;
        app.planner_llm = LlmProvider::OpenAI;
        app.story_llm = LlmProvider::Codex;

        assert_eq!(app.model_for_phase("architect").as_deref(), Some("opus"));
        assert_eq!(app.model_for_phase("planning").as_deref(), Some("gpt-5.5"));
        assert_eq!(app.model_for_phase("story"), None);
    }

    #[test]
    fn v2_events_update_story_signals() {
        let mut app = app_with_run();
        assert_eq!(app.run_mode.as_deref(), Some("focused"));

        feed(&mut app, r#"{"type":"routed","id":"S1","backend":"codex","model":"gpt-5.3"}"#);
        assert_eq!(app.story("S1").route.as_deref(), Some("codex:gpt-5.3"));

        feed(&mut app, r#"{"type":"critique","id":"S1","verdict":"fail","reasoning":"no tests","violated":["AC1"]}"#);
        assert_eq!(app.story("S1").critic_pass, Some(false));
        // Story-scoped system entry lands in the active story's feed.
        let feed_s1 = &app.active_stories.get("S1").unwrap().activity;
        assert!(feed_s1.last().unwrap().system);
        assert!(feed_s1.last().unwrap().text.contains("AC1"));

        feed(&mut app, r#"{"type":"story_retry","id":"S1","attempt":2}"#);
        assert_eq!(app.story("S1").retry_count, 2);

        feed(&mut app, r#"{"type":"intervention","id":"S1","source":"sentry","action":"aborted","reason":"stall"}"#);
        assert_eq!(app.story("S1").intervened.as_deref(), Some("aborted"));

        feed(&mut app, r#"{"type":"story_merged","id":"S1","mode":"worktree"}"#);
        assert_eq!(app.story("S1").merge, Some(true));
        feed(&mut app, r#"{"type":"merge_failed","id":"S2","error":"conflict"}"#);
        assert_eq!(app.story("S2").merge, Some(false));
    }

    #[test]
    fn replan_adds_removes_and_rewires() {
        let mut app = app_with_run();
        feed(
            &mut app,
            r#"{"type":"story_error","id":"S2","error":"first attempt failed","attempt":1,"max_retries":1}"#,
        );
        assert_eq!(app.story("S2").status, StoryStatus::Failed);
        feed(
            &mut app,
            r#"{"type":"replan","source":"sentry","reason":"scope shift",
                "added":[{"id":"S3","title":"Three","depends_on":["S1"]}],
                "removed":["S2"],"rewired":[{"id":"S1","depends_on":[]}]}"#,
        );
        assert_eq!(app.story("S3").replan, Some(ReplanMark::Added));
        assert_eq!(app.story("S3").depends_on, vec!["S1"]);
        assert_eq!(
            app.story("S2").replan,
            Some(ReplanMark::Removed("scope shift".into()))
        );
        assert_eq!(app.story("S2").status, StoryStatus::Skipped);
        assert_eq!(app.total, 2);
        assert_eq!(app.dag_levels, vec![vec!["S1"], vec!["S3"]]);
        // Run-level system entry is fanned out to active feeds.
        let feed_s1 = &app.active_stories.get("S1").unwrap().activity;
        assert!(feed_s1.last().unwrap().text.contains("scope shift"));

        feed(
            &mut app,
            r#"{"type":"replan","source":"board","reason":"safe replacement",
                "added":[{"id":"S2","title":"Two replacement","depends_on":["S3"]}],
                "removed":[],"rewired":[]}"#,
        );
        assert_eq!(app.story("S2").status, StoryStatus::Pending);
        assert_eq!(app.total, 3);
        assert_eq!(app.story("S2").title, "Two replacement");
        assert_eq!(app.story("S2").depends_on, vec!["S3"]);
        assert_eq!(
            app.dag_levels,
            vec![vec!["S1"], vec!["S3"], vec!["S2"]]
        );
    }

    #[test]
    fn explorer_agent_navigation_skips_header_rows() {
        let mut app = app_with_run();
        feed(&mut app, r#"{"type":"dag","levels":[[{"id":"S1"}],[{"id":"S2"}]]}"#);
        // header, S1, connector, header, S2
        assert_eq!(
            app.agent_item_rows(),
            vec![None, Some("S1".into()), None, None, Some("S2".into())]
        );

        app.explorer_agents_move(1);
        assert_eq!(app.story_list_state.selected(), Some(1));
        assert_eq!(app.activity_filter.as_deref(), Some("S1"));
        assert_eq!(app.main_view, MainView::Activity);

        app.explorer_agents_move(1);
        assert_eq!(app.story_list_state.selected(), Some(4));
        assert_eq!(app.activity_filter.as_deref(), Some("S2"));

        // At the bottom edge: stays put.
        app.explorer_agents_move(1);
        assert_eq!(app.story_list_state.selected(), Some(4));

        app.explorer_agents_move(-1);
        assert_eq!(app.activity_filter.as_deref(), Some("S1"));
    }

    #[test]
    fn message_target_prefers_explorer_selection_then_pin_then_tab() {
        let mut app = app_with_run();
        feed(&mut app, r#"{"type":"dag","levels":[[{"id":"S1"}],[{"id":"S2"}]]}"#);

        // Default: tab-selected active story.
        assert_eq!(app.message_target().as_deref(), Some("S1"));

        // Pinned agent wins, but only while it's running.
        app.activity_filter = Some("S2".to_string());
        assert_eq!(app.message_target(), None); // S2 not active
        feed(&mut app, r#"{"type":"story_start","id":"S2","title":"Two"}"#);
        assert_eq!(app.message_target().as_deref(), Some("S2"));

        // Agents-focus selection wins over the pin.
        app.focus = WorkbenchFocus::Agents;
        app.story_list_state.select(Some(1)); // S1's row (header at 0)
        assert_eq!(app.message_target().as_deref(), Some("S1"));
    }

    #[test]
    fn echo_user_message_lands_in_the_agent_feed() {
        let mut app = app_with_run();
        app.echo_user_message("S1", "check the edge cases");
        let entry = app.active_stories.get("S1").unwrap().activity.last().unwrap();
        assert_eq!(entry.kind, "user");
        assert!(!entry.system);
        assert_eq!(entry.text, "you → S1: check the edge cases");
        // Echo to a non-active story is a no-op, not a panic.
        app.echo_user_message("S9", "hello");
    }

    #[test]
    fn collective_dialogue_is_a_separate_non_story_message_lane() {
        let mut app = app_with_run();
        app.dialogue_enabled = true;
        app.open_dialogue();

        assert_eq!(
            app.agent_msg_input.as_ref().map(|(id, _)| id.as_str()),
            Some(DIALOGUE_AGENT_ID),
        );
        assert_eq!(app.activity_filter.as_deref(), Some(DIALOGUE_AGENT_ID));
        assert_eq!(app.message_target(), None);

        app.echo_user_message(DIALOGUE_AGENT_ID, "what is blocked?");
        let entry = app
            .active_stories
            .get(DIALOGUE_AGENT_ID)
            .unwrap()
            .activity
            .last()
            .unwrap();
        assert_eq!(entry.text, "you → collective: what is blocked?");
    }

    #[test]
    fn explorer_file_navigation_targets_diff() {
        let mut app = app_with_run();
        feed(
            &mut app,
            r#"{"type":"story_diff","id":"S1",
                "files":[{"path":"src/a.rs","added":3,"removed":1},{"path":"src/b.rs","added":2,"removed":0}],
                "diff":"+++ b/src/a.rs\n+x\n+++ b/src/b.rs\n+y"}"#,
        );
        app.explorer_files_move(1);
        assert_eq!(app.explorer_file_ix, 1);
        assert_eq!(app.diff_target.as_deref(), Some("src/b.rs"));
        assert!(app.diff_scroll_pending);
        assert_eq!(app.main_view, MainView::Diff);

        // Clamped at both ends.
        app.explorer_files_move(5);
        assert_eq!(app.explorer_file_ix, 1);
        app.explorer_files_move(-5);
        assert_eq!(app.explorer_file_ix, 0);
        assert_eq!(app.diff_target.as_deref(), Some("src/a.rs"));
    }

    #[test]
    fn level_and_recovery_state() {
        let mut app = app_with_run();
        feed(&mut app, r#"{"type":"level_started","ordinal":0,"story_ids":["S1"]}"#);
        assert_eq!(app.level_states.get(&0), Some(&LevelRunState::Running));
        feed(&mut app, r#"{"type":"level_completed","ordinal":0,"passed":[],"failed":["S1"]}"#);
        assert_eq!(app.level_states.get(&0), Some(&LevelRunState::Done { failed: true }));
        feed(&mut app, r#"{"type":"recovery_started","attempt":1,"story_ids":["S1"]}"#);
        assert_eq!(app.recoveries, vec![(1, vec!["S1".to_string()])]);
    }

    #[test]
    fn embedded_verification_is_canonical_and_mismatch_fails_closed() {
        let mut app = app_with_run();
        feed(
            &mut app,
            r#"{"type":"done","total_time_secs":1,"success":true,
                "verification_status":"passed",
                "verification":{"verification_id":"v1","status":"failed",
                "duration_ms":1,"commands":[]},
                "stats":{"stories_completed":1,"stories_skipped":0,
                "total_commits":0,"files_created":0,"files_modified":0}}"#,
        );

        assert_eq!(app.verification_status.as_deref(), Some("failed"));
        assert!(app
            .exit_reason
            .as_deref()
            .unwrap_or_default()
            .contains("Inconsistent objective verification"));
    }

    #[test]
    fn unknown_verification_status_never_renders_as_green() {
        let mut app = app_with_run();
        feed(
            &mut app,
            r#"{"type":"done","total_time_secs":1,"success":true,
                "verification_status":"mystery",
                "stats":{"stories_completed":1,"stories_skipped":0,
                "total_commits":0,"files_created":0,"files_modified":0}}"#,
        );

        assert_eq!(app.verification_status.as_deref(), Some("failed"));
        assert!(app.exit_reason.is_some());
    }
}
