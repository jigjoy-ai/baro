use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Gauge, Paragraph},
    Frame,
};

use crate::app::{App, GlobalTab, StoryStatus};
use crate::theme;

/// Count stories by status for use in headers and progress widgets.
/// Derived from `app.stories` directly so the counter reflects real
/// per-story progress regardless of what the orchestrator emits over
/// the legacy level-based `progress` event.
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

use super::execute_completion::render_completion;
use super::execute_dashboard::render_dashboard;
use super::execute_dag::render_dag_full;
use super::execute_stats::render_stats_full;

pub fn render(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Header + tabs
            Constraint::Min(8),   // Main content (tab-dependent)
            Constraint::Length(3), // Progress bar
            Constraint::Length(1), // Footer
        ])
        .split(f.area());

    render_header(f, app, chunks[0]);

    // Clear the tab content area each frame so a previous tab's
    // characters don't bleed through when the user switches tabs (or
    // when the new tab renders less content than the old one).
    f.render_widget(Clear, chunks[1]);

    match app.global_tab {
        GlobalTab::Dashboard => render_dashboard(f, app, chunks[1]),
        GlobalTab::Dag => render_dag_full(f, app, chunks[1]),
        GlobalTab::Stats => render_stats_full(f, app, chunks[1]),
    }

    render_progress(f, app, chunks[2]);
    render_footer(f, app, chunks[3]);

    if app.done {
        render_completion(f, app);
    }
}

// --- Header with Tabs ---

fn render_header(f: &mut Frame, app: &App, area: Rect) {
    let header_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Min(20),
            Constraint::Length(28),
        ])
        .split(area);

    let elapsed = app.elapsed_secs();
    let counts = count_stories(app);

    let info_line = Line::from(vec![
        Span::styled(
            " BARO ",
            Style::default().fg(theme::LOGO_1).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" \u{2502} ", Style::default().fg(theme::BORDER)),
        Span::styled(
            &app.project,
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" \u{2502} ", Style::default().fg(theme::BORDER)),
        Span::styled(
            format!("{}/{}", counts.passed, counts.total),
            Style::default().fg(theme::SUCCESS),
        ),
        Span::styled(" \u{2502} ", Style::default().fg(theme::BORDER)),
        Span::styled(
            format!("{:02}:{:02}", elapsed / 60, elapsed % 60),
            Style::default().fg(theme::MUTED),
        ),
    ]);

    let info = Paragraph::new(info_line).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER)),
    );
    f.render_widget(info, header_chunks[0]);

    let active_tab = app.global_tab.index();
    let tab_line = Line::from(vec![
        Span::styled(
            "1:Dashboard",
            if active_tab == 0 {
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            },
        ),
        Span::raw("  "),
        Span::styled(
            "2:DAG",
            if active_tab == 1 {
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            },
        ),
        Span::raw("  "),
        Span::styled(
            "3:Stats",
            if active_tab == 2 {
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            },
        ),
    ]);

    let tabs = Paragraph::new(tab_line).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER)),
    );
    f.render_widget(tabs, header_chunks[1]);
}

// --- Shared: Progress Bar ---

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
        label.push_str(&format!(", {} skipped", counts.skipped));
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
        .gauge_style(Style::default().fg(theme::GAUGE_FG))
        .ratio(ratio)
        .label(Span::styled(
            label,
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ));

    f.render_widget(gauge, area);
}

// --- Shared: Footer ---

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let msg = if app.finalize_in_progress {
        " Finalizing...".to_string()
    } else if app.done {
        let stats = app.final_stats.as_ref();
        let completed = stats.map(|s| s.stories_completed).unwrap_or(0);
        let skipped = stats.map(|s| s.stories_skipped).unwrap_or(0);
        let elapsed = app.total_time_secs;
        format!(
            " Done! {} completed, {} skipped in {}:{:02} | q:exit",
            completed,
            skipped,
            elapsed / 60,
            elapsed % 60,
        )
    } else {
        " 1/2/3:tabs | Tab/Shift+Tab:logs | \u{2191}\u{2193}:scroll | q:quit".to_string()
    };

    let footer = Paragraph::new(Span::styled(msg, Style::default().fg(theme::MUTED)));
    f.render_widget(footer, area);
}

// --- Helpers ---

pub(crate) fn status_icon_color(status: &StoryStatus) -> (&'static str, ratatui::style::Color) {
    match status {
        StoryStatus::Complete => ("✓", theme::SUCCESS),
        StoryStatus::Running => ("▶", theme::WARNING),
        StoryStatus::Failed => ("✗", theme::ERROR),
        StoryStatus::Retrying(_) => ("↻", theme::WARNING),
        StoryStatus::Skipped => ("⊘", theme::MUTED),
        StoryStatus::Pending => ("○", theme::MUTED),
    }
}
