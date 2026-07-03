//! EXECUTE screen: terminal-IDE workbench.
//!
//! ┌ top bar: goal · mode · status · cost/tokens ──────────────┐
//! │ rail │ explorer (agents/changes) │ main view (A/P/D/S/◆) │
//! │ progress · status bar · key hints                         │
//! └───────────────────────────────────────────────────────────┘

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Gauge, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap},
    Frame,
};

use crate::app::{App, MainView, StoryStatus, WorkbenchFocus, EXPLORER_MAX_WIDTH, EXPLORER_MIN_WIDTH};
use crate::screens::widgets::{pane_block, truncate_for_panel};
use crate::theme;
use crate::utils::format_commas;

// Workbench breakpoints: below BP_EXPLORER the explorer is hidden (single
// pane); below BP_WIDE the rail collapses and the explorer goes compact.
pub const BP_EXPLORER: u16 = 70;
pub const BP_WIDE: u16 = 100;
const RAIL_WIDTH: u16 = 4;
const EXPLORER_COMPACT_WIDTH: u16 = 20;

/// Count stories by status for headers and progress widgets. Derived from
/// `app.stories` directly so counters reflect real per-story progress
/// regardless of the legacy level-based `progress` event.
struct StoryCounts {
    total: u32,
    passed: u32,
    running: u32,
    failed: u32,
    skipped: u32,
}

fn count_stories(app: &App) -> StoryCounts {
    let mut c = StoryCounts {
        total: app.stories.len() as u32,
        passed: 0,
        running: 0,
        failed: 0,
        skipped: 0,
    };
    for s in &app.stories {
        match s.status {
            StoryStatus::Complete => c.passed += 1,
            StoryStatus::Running => c.running += 1,
            StoryStatus::Failed | StoryStatus::Retrying(_) => c.failed += 1,
            StoryStatus::Skipped => c.skipped += 1,
            StoryStatus::Pending => {}
        }
    }
    c
}

use super::execute_activity::render_activity;
use super::execute_completion::render_completion;
use super::execute_dag::render_dag_full;
use super::execute_explorer::render_explorer;
use super::execute_stats::render_stats_full;

pub fn render(f: &mut Frame, app: &mut App) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // top bar
            Constraint::Min(6),   // workbench (rail + explorer + main)
            Constraint::Length(3), // progress
            Constraint::Length(1), // status bar
            Constraint::Length(1), // key hints / follow-up affordance
        ])
        .split(f.area());

    render_top_bar(f, app, rows[0]);

    // Clear the workbench area each frame so a previous view's characters
    // don't bleed through when panes move or shrink.
    f.render_widget(Clear, rows[1]);

    let (rail, explorer, main) =
        workbench_columns(rows[1], app.explorer_visible, app.explorer_width);
    if let Some(rail_area) = rail {
        render_rail(f, app, rail_area);
    }
    if let Some(explorer_area) = explorer {
        render_explorer(f, app, explorer_area);
    }
    render_main(f, app, main);

    render_progress(f, app, rows[2]);
    render_status_bar(f, app, rows[3]);
    render_footer(f, app, rows[4]);

    if app.done {
        render_completion(f, app);
    }
}

/// Split the workbench row into (rail, explorer, main) by breakpoint:
/// wide keeps everything, medium drops the rail and compacts the explorer,
/// narrow is a single main pane.
pub(crate) fn workbench_columns(
    area: Rect,
    explorer_visible: bool,
    explorer_width: u16,
) -> (Option<Rect>, Option<Rect>, Rect) {
    let w = area.width;
    let rail_w = if w >= BP_WIDE { RAIL_WIDTH } else { 0 };
    let explorer_w = if !explorer_visible || w < BP_EXPLORER {
        0
    } else if w < BP_WIDE {
        EXPLORER_COMPACT_WIDTH
    } else {
        explorer_width.clamp(EXPLORER_MIN_WIDTH, EXPLORER_MAX_WIDTH)
    };

    let mut constraints: Vec<Constraint> = Vec::new();
    if rail_w > 0 {
        constraints.push(Constraint::Length(rail_w));
    }
    if explorer_w > 0 {
        constraints.push(Constraint::Length(explorer_w));
    }
    constraints.push(Constraint::Min(10));

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(constraints)
        .split(area);

    let mut ix = 0;
    let rail = if rail_w > 0 {
        ix += 1;
        Some(chunks[0])
    } else {
        None
    };
    let explorer = if explorer_w > 0 {
        ix += 1;
        Some(chunks[ix - 1])
    } else {
        None
    };
    (rail, explorer, chunks[ix])
}

// --- Rail: main-view switcher anchor ---

fn render_rail(f: &mut Frame, app: &App, area: Rect) {
    let mut entries: Vec<(&str, MainView)> = vec![
        ("A", MainView::Activity),
        ("P", MainView::Plan),
        ("D", MainView::Diff),
        ("S", MainView::Stats),
    ];
    if app.decision_document.is_some() {
        entries.push(("◆", MainView::Decisions));
    }

    let mut lines = vec![Line::from("")];
    for (icon, view) in entries {
        if app.main_view == view {
            lines.push(Line::from(Span::styled(
                format!(" {} ", icon),
                Style::default()
                    .fg(theme::BG)
                    .bg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            )));
        } else {
            lines.push(Line::from(Span::styled(
                format!(" {} ", icon),
                Style::default().fg(theme::MUTED),
            )));
        }
        lines.push(Line::from(""));
    }

    let p = Paragraph::new(lines).block(
        Block::default()
            .borders(Borders::RIGHT)
            .border_style(Style::default().fg(theme::BORDER)),
    );
    f.render_widget(p, area);
}

// --- Top bar: goal · mode badge · status · cost/tokens ---

fn render_top_bar(f: &mut Frame, app: &App, area: Rect) {
    let counts = count_stories(app);
    let elapsed = app.elapsed_secs();
    let (word, color) = run_status(app);

    let sep = || Span::styled(" \u{2502} ", Style::default().fg(theme::BORDER));
    let mut spans = vec![
        Span::styled(
            " BARO ",
            Style::default().fg(theme::LOGO_1).add_modifier(Modifier::BOLD),
        ),
        sep(),
        Span::styled(
            &app.project,
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
    ];
    if !app.goal_input.is_empty() {
        spans.push(Span::styled(
            format!(" — {}", truncate_for_panel(&app.goal_input, 48)),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }
    if let Some(mode) = &app.run_mode {
        if !mode.is_empty() {
            spans.push(sep());
            spans.push(Span::styled(
                format!(" {} ", mode),
                Style::default().fg(theme::BG).bg(theme::ACCENT_DIM),
            ));
        }
    }
    spans.extend([
        sep(),
        Span::styled("\u{25CF} ", Style::default().fg(color)),
        Span::styled(word, Style::default().fg(color).add_modifier(Modifier::BOLD)),
        sep(),
        Span::styled(
            format!("{}/{}", counts.passed, counts.total),
            Style::default().fg(theme::SUCCESS),
        ),
        sep(),
        Span::styled(
            format!("{:02}:{:02}", elapsed / 60, elapsed % 60),
            Style::default().fg(theme::MUTED),
        ),
    ]);
    let tokens = app.total_input_tokens + app.total_output_tokens;
    if tokens > 0 {
        spans.push(sep());
        spans.push(Span::styled(
            format!("{} tok", format_commas(tokens)),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }
    if app.total_cost_usd > 0.0 {
        spans.push(sep());
        spans.push(Span::styled(
            format!("${:.2}", app.total_cost_usd),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }

    let bar = Paragraph::new(Line::from(spans)).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER)),
    );
    f.render_widget(bar, area);
}

fn run_status(app: &App) -> (&'static str, Color) {
    if app.done {
        if app.exit_reason.is_some() {
            ("failed", theme::ERROR)
        } else {
            ("done", theme::SUCCESS)
        }
    } else if app.finalize_in_progress {
        ("finalizing", theme::ACCENT)
    } else if app.review_in_progress {
        ("reviewing", theme::ACCENT)
    } else {
        ("running", theme::ACCENT)
    }
}

// --- Main view ---

fn render_main(f: &mut Frame, app: &mut App, area: Rect) {
    match app.main_view {
        MainView::Activity => render_activity(f, app, area),
        MainView::Plan => render_dag_full(f, app, area),
        MainView::Stats => render_stats_full(f, app, area),
        MainView::Diff => render_diff(f, app, area),
        MainView::Decisions => render_decisions(f, app, area),
    }
}

// --- Diff view: per-story unified diffs, scrollable, file-targetable ---

fn render_diff(f: &mut Frame, app: &mut App, area: Rect) {
    let focused = app.focus == WorkbenchFocus::Main;
    let title = match &app.diff_target {
        Some(path) => format!(" diff — {} ", path),
        None => " diff ".to_string(),
    };

    if app.story_diffs.is_empty() {
        let p = Paragraph::new(Line::from(Span::styled(
            "  No changes yet — diffs appear here as stories merge into the run branch.",
            Style::default().fg(theme::MUTED),
        )))
        .block(pane_block(" diff ".to_string(), focused));
        f.render_widget(p, area);
        return;
    }

    // Stable order by story id; additions green, deletions red, hunk
    // headers amber (mirrors the web run view).
    let mut diffs: Vec<(&String, &String)> = app.story_diffs.iter().collect();
    diffs.sort_by(|a, b| a.0.cmp(b.0));

    let mut lines: Vec<Line> = Vec::new();
    let mut target_line: Option<usize> = None;
    for (sid, text) in diffs {
        lines.push(Line::from(Span::styled(
            format!("\u{258C} {}", sid),
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        )));
        for raw in text.lines() {
            if target_line.is_none() {
                if let Some(path) = &app.diff_target {
                    if raw.starts_with("+++ ") && raw.ends_with(path.as_str()) {
                        target_line = Some(lines.len());
                    }
                }
            }
            let style = if raw.starts_with("+++")
                || raw.starts_with("---")
                || raw.starts_with("diff ")
                || raw.starts_with("index ")
            {
                Style::default().fg(theme::MUTED)
            } else if raw.starts_with("@@") {
                Style::default().fg(theme::ACCENT)
            } else if raw.starts_with('+') {
                Style::default().fg(theme::SUCCESS)
            } else if raw.starts_with('-') {
                Style::default().fg(theme::ERROR)
            } else {
                Style::default().fg(theme::TEXT_DIM)
            };
            lines.push(Line::from(Span::styled(raw.to_string(), style)));
        }
        lines.push(Line::from(""));
    }

    let total = lines.len().min(u16::MAX as usize) as u16;
    let inner_height = area.height.saturating_sub(2);
    let max_scroll = total.saturating_sub(inner_height);
    if app.diff_scroll_pending {
        // Jump so the "+++ b/<file>" header of the explorer-selected file
        // sits one line below the pane top.
        if let Some(ix) = target_line {
            app.diff_scroll_offset = (ix as u16).saturating_sub(1);
        }
        app.diff_scroll_pending = false;
    }
    app.diff_scroll_offset = app.diff_scroll_offset.min(max_scroll);

    let p = Paragraph::new(lines)
        .block(pane_block(title, focused))
        .scroll((app.diff_scroll_offset, 0));
    f.render_widget(p, area);

    if total > inner_height {
        let mut scrollbar_state =
            ScrollbarState::new(max_scroll as usize).position(app.diff_scroll_offset as usize);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::ACCENT_DIM));
        f.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
    }
}

// --- Decisions view: the Architect's decision document ---

fn render_decisions(f: &mut Frame, app: &mut App, area: Rect) {
    let focused = app.focus == WorkbenchFocus::Main;
    let Some(doc) = app.decision_document.clone() else {
        let p = Paragraph::new(Line::from(Span::styled(
            "  No decision document — the Architect didn't produce one for this run.",
            Style::default().fg(theme::MUTED),
        )))
        .block(pane_block(" decisions ".to_string(), focused));
        f.render_widget(p, area);
        return;
    };

    let lines: Vec<Line> = doc
        .lines()
        .map(|l| {
            // Light markdown accents: headings amber, list bullets dimmed.
            if l.starts_with('#') {
                Line::from(Span::styled(
                    l.to_string(),
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                ))
            } else {
                Line::from(Span::styled(l.to_string(), Style::default().fg(theme::TEXT)))
            }
        })
        .collect();

    let p = Paragraph::new(lines)
        .block(pane_block(" decisions ".to_string(), focused))
        .wrap(Wrap { trim: false });
    let total = p.line_count(area.width.saturating_sub(2)).min(u16::MAX as usize) as u16;
    let inner_height = area.height.saturating_sub(2);
    let max_scroll = total.saturating_sub(inner_height);
    app.decisions_scroll = app.decisions_scroll.min(max_scroll);
    f.render_widget(p.scroll((app.decisions_scroll, 0)), area);

    if total > inner_height {
        let mut scrollbar_state =
            ScrollbarState::new(max_scroll as usize).position(app.decisions_scroll as usize);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::ACCENT_DIM));
        f.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
    }
}

// --- Bottom strip: progress · status bar · hints ---

fn render_progress(f: &mut Frame, app: &App, area: Rect) {
    let counts = count_stories(app);
    let ratio = if counts.total > 0 {
        (counts.passed as f64 / counts.total as f64).min(1.0)
    } else {
        0.0
    };
    let pct = (ratio * 100.0).round() as u32;

    let mut label = format!("{}% ({}/{} stories", pct, counts.passed, counts.total);
    if counts.running > 0 {
        label.push_str(&format!(", {} running", counts.running));
    }
    if counts.failed > 0 {
        label.push_str(&format!(", {} failed", counts.failed));
    }
    if counts.skipped > 0 {
        label.push_str(&format!(", {} dropped", counts.skipped));
    }
    label.push(')');

    let gauge = Gauge::default()
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    " Progress ",
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                )),
        )
        // bg = dark so the label over the filled bar renders dark-on-amber
        // (ratatui reverses gauge_style for the label portion on the bar);
        // over the unfilled part the label keeps its light fg on the dark bg.
        .gauge_style(Style::default().fg(theme::GAUGE_FG).bg(theme::BG))
        .ratio(ratio)
        .label(Span::styled(
            label,
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ));

    f.render_widget(gauge, area);
}

// Full-width run status, mirroring the web run-view bar:
//   ● status · elapsed · agents · tokens · files [· cost] · repo [· runner] [· branch] [· PR]
fn render_status_bar(f: &mut Frame, app: &App, area: Rect) {
    let counts = count_stories(app);
    let elapsed = app.elapsed_secs();
    let (word, color) = run_status(app);

    let agents = if app.done {
        format!("{} agents", counts.total)
    } else {
        format!("{}/{} agents", counts.running, counts.total)
    };

    // Files touched: aggregate from final_stats once done, else sum live per-story counts.
    let files: u32 = app
        .final_stats
        .as_ref()
        .map(|s| s.files_created + s.files_modified)
        .unwrap_or_else(|| {
            app.stories
                .iter()
                .map(|s| s.files_created + s.files_modified)
                .sum()
        });

    let tokens = format_commas(app.total_input_tokens + app.total_output_tokens);

    let sep = || Span::styled("  ·  ", Style::default().fg(theme::BORDER));
    let mut spans = vec![
        Span::styled(" \u{25CF} ", Style::default().fg(color)),
        Span::styled(word, Style::default().fg(color).add_modifier(Modifier::BOLD)),
        sep(),
        Span::styled(
            format!("{:02}:{:02}", elapsed / 60, elapsed % 60),
            Style::default().fg(theme::TEXT_DIM),
        ),
        sep(),
        Span::styled(agents, Style::default().fg(theme::TEXT_DIM)),
        sep(),
        Span::styled(format!("{} tok", tokens), Style::default().fg(theme::TEXT_DIM)),
        sep(),
        Span::styled(format!("{} files", files), Style::default().fg(theme::TEXT_DIM)),
    ];
    // Cost: only backends that report it (Claude CLI) contribute; omit when zero
    // so subscription runs don't show a misleading $0.00.
    if app.total_cost_usd > 0.0 {
        spans.push(sep());
        spans.push(Span::styled(
            format!("${:.2}", app.total_cost_usd),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }
    if !app.project.is_empty() {
        spans.push(sep());
        spans.push(Span::styled(
            app.project.clone(),
            Style::default().fg(theme::ACCENT_DIM),
        ));
    }
    if let Some(runner) = &app.runner {
        if !runner.is_empty() {
            spans.push(sep());
            spans.push(Span::styled(
                runner.clone(),
                Style::default().fg(theme::MUTED),
            ));
        }
    }
    if !app.branch_name.is_empty() {
        spans.push(sep());
        spans.push(Span::styled(
            format!("\u{2387} {}", app.branch_name),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }
    if let Some(pr_url) = &app.pr_url {
        spans.push(sep());
        spans.push(Span::styled(
            pr_url.clone(),
            Style::default().fg(theme::ACCENT_DIM),
        ));
    }

    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let line = if app.finalize_in_progress {
        Line::from(Span::styled(
            " Finalizing...",
            Style::default().fg(theme::MUTED),
        ))
    } else if app.done && app.exit_reason.is_none() {
        // Visible prompt-box affordance, not just a keybind note.
        Line::from(vec![
            Span::styled(
                " \u{25B8} follow-up: press f ",
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
            ),
            Span::styled("  ·  q quit", Style::default().fg(theme::MUTED)),
        ])
    } else if app.done {
        Line::from(Span::styled(
            " r rerun failed  ·  q quit",
            Style::default().fg(theme::MUTED),
        ))
    } else {
        Line::from(Span::styled(
            " 1-5 views \u{00B7} Tab focus \u{00B7} \u{2191}\u{2193} scroll/select \u{00B7} e explorer \u{00B7} [ ] width \u{00B7} q quit",
            Style::default().fg(theme::MUTED),
        ))
    };

    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::EXPLORER_DEFAULT_WIDTH;

    fn rect(w: u16, h: u16) -> Rect {
        Rect::new(0, 0, w, h)
    }

    #[test]
    fn wide_terminal_shows_rail_and_explorer() {
        let (rail, explorer, main) = workbench_columns(rect(160, 40), true, EXPLORER_DEFAULT_WIDTH);
        let rail = rail.expect("rail at >=100 cols");
        let explorer = explorer.expect("explorer visible");
        assert_eq!(rail.width, RAIL_WIDTH);
        assert_eq!(explorer.width, EXPLORER_DEFAULT_WIDTH);
        assert_eq!(rail.width + explorer.width + main.width, 160);
        assert_eq!(main.x, rail.width + explorer.width);
    }

    #[test]
    fn medium_terminal_drops_rail_and_compacts_explorer() {
        let (rail, explorer, main) = workbench_columns(rect(80, 40), true, EXPLORER_DEFAULT_WIDTH);
        assert!(rail.is_none());
        let explorer = explorer.expect("compact explorer at 70..100 cols");
        assert_eq!(explorer.width, EXPLORER_COMPACT_WIDTH);
        assert_eq!(explorer.width + main.width, 80);
    }

    #[test]
    fn narrow_terminal_is_single_pane() {
        let (rail, explorer, main) = workbench_columns(rect(60, 40), true, EXPLORER_DEFAULT_WIDTH);
        assert!(rail.is_none());
        assert!(explorer.is_none());
        assert_eq!(main.width, 60);
    }

    #[test]
    fn explorer_toggle_hides_it_but_keeps_rail() {
        let (rail, explorer, main) = workbench_columns(rect(160, 40), false, EXPLORER_DEFAULT_WIDTH);
        assert!(rail.is_some());
        assert!(explorer.is_none());
        assert_eq!(main.width, 160 - RAIL_WIDTH);
    }

    #[test]
    fn explorer_width_clamps_to_limits() {
        let (_, explorer, _) = workbench_columns(rect(160, 40), true, 99);
        assert_eq!(explorer.unwrap().width, EXPLORER_MAX_WIDTH);
        let (_, explorer, _) = workbench_columns(rect(160, 40), true, 1);
        assert_eq!(explorer.unwrap().width, EXPLORER_MIN_WIDTH);
    }

    #[test]
    fn tiny_sizes_do_not_panic() {
        for (w, h) in [(0, 0), (1, 1), (5, 2), (12, 1), (69, 0), (100, 1)] {
            let (_, _, main) = workbench_columns(rect(w, h), true, EXPLORER_DEFAULT_WIDTH);
            assert!(main.width <= w);
        }
    }
}
