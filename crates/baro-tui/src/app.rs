use std::collections::HashMap;
use std::time::Instant;

use ratatui::widgets::ListState;

use crate::events::{BaroEvent, DoneStats};

use crate::constants::MAX_LOG_LINES;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Screen {
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
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WelcomeField {
    Goal,
    Model,
    Parallel,
    Timeout,
    Context,
    Planner,
}

impl WelcomeField {
    pub fn next(self) -> Self {
        match self {
            Self::Goal => Self::Model,
            Self::Model => Self::Parallel,
            Self::Parallel => Self::Timeout,
            Self::Timeout => Self::Context,
            Self::Context => Self::Planner,
            Self::Planner => Self::Goal,
        }
    }
    pub fn prev(self) -> Self {
        match self {
            Self::Goal => Self::Planner,
            Self::Model => Self::Goal,
            Self::Parallel => Self::Model,
            Self::Timeout => Self::Parallel,
            Self::Context => Self::Timeout,
            Self::Planner => Self::Context,
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

#[derive(Debug, Clone, PartialEq)]
pub enum StoryStatus {
    Pending,
    Running,
    Complete,
    Failed,
    Retrying(u32),
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

    // Welcome screen
    pub goal_input: String,
    pub welcome_field: WelcomeField,

    // Context building screen
    pub claude_md_content: Option<String>,

    // Planning screen
    pub planning_start: Option<Instant>,
    pub planning_error: Option<String>,

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
    pub with_sentry: bool,
    pub with_surgeon: bool,
    pub surgeon_use_llm: bool,
    pub surgeon_model: Option<String>,

    // Context building
    pub skip_context: bool,

    // Dry run mode
    pub dry_run: bool,

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

            goal_input: String::new(),
            welcome_field: WelcomeField::Goal,

            claude_md_content: None,

            planning_start: None,
            planning_error: None,

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
            timeout_secs: 600,
            notification_ready: false,
            model_routing: true,
            override_model: None,
            with_critic: true,
            critic_model: None,
            with_librarian: true,
            with_sentry: true,
            with_surgeon: true,
            surgeon_use_llm: true,
            surgeon_model: None,
            skip_context: false,
            dry_run: false,
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
    }

    pub fn planning_elapsed_secs(&self) -> u64 {
        self.planning_start
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0)
    }

    // Planner toggle
    pub fn toggle_planner(&mut self) {
        self.planner = match self.planner {
            Planner::Claude => Planner::OpenAI,
            Planner::OpenAI => Planner::Claude,
        };
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
                self.stories = stories
                    .into_iter()
                    .map(|s| StoryState {
                        id: s.id,
                        title: s.title,
                        depends_on: s.depends_on,
                        status: StoryStatus::Pending,
                        duration_secs: None,
                        error: None,
                        files_created: 0,
                        files_modified: 0,
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
                    if attempt >= max_retries {
                        story.status = StoryStatus::Skipped;
                        story.error = Some(error);
                        self.active_stories.remove(&id);
                    } else {
                        story.status = StoryStatus::Failed;
                        story.error = Some(error);
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
            } => {
                self.done = true;
                self.total_time_secs = total_time_secs;
                self.final_stats = Some(stats);
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
        if let Some(ref model) = self.override_model {
            return Some(model.clone());
        }
        if self.model_routing {
            return match phase {
                "planning" => Some("opus".to_string()),
                "execution" => Some("sonnet".to_string()),
                "review" => Some("haiku".to_string()),
                _ => None,
            };
        }
        None
    }
}
