use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Gauge, Paragraph},
    Frame,
};

use crate::app::{App, MainView, StoryStatus};
use crate::theme;
use crate::utils::format_commas;

// Workbench breakpoints: below BP_EXPLORER the explorer is hidden (single
// pane); below BP_WIDE the rail collapses and the explorer goes compact.
pub const BP_EXPLORER: u16 = 70;
pub const BP_WIDE: u16 = 100;

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
            Constraint::Length(1), // Status bar
            Constraint::Length(1), // Footer
        ])
        .split(f.area());

    render_header(f, app, chunks[0]);

    // Clear the tab content area each frame so a previous tab's
    // characters don't bleed through when the user switches tabs (or
    // when the new tab renders less content than the old one).
    f.render_widget(Clear, chunks[1]);

    match app.main_view {
        MainView::Activity => render_dashboard(f, app, chunks[1]),
        MainView::Plan => render_dag_full(f, app, chunks[1]),
        MainView::Stats => render_stats_full(f, app, chunks[1]),
        MainView::Diff | MainView::Decisions => render_changes(f, app, chunks[1]),
    }

    render_progress(f, app, chunks[2]);
    render_status_bar(f, app, chunks[3]);
    render_footer(f, app, chunks[4]);

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
            Constraint::Length(42),
        ])
        .split(area);

    let elapsed = app.elapsed_secs();
    let counts = count_stories(app);

    let mut info_spans = vec![
        Span::styled(
            " BARO ",
            Style::default().fg(theme::LOGO_1).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" \u{2502} ", Style::default().fg(theme::BORDER)),
        Span::styled(
            &app.project,
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
    ];
    if let Some(mode) = &app.run_mode {
        if !mode.is_empty() {
            info_spans.push(Span::styled(
                format!(" {} ", mode),
                Style::default().fg(theme::TEXT_DIM),
            ));
        }
    }
    info_spans.extend([
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
    let info_line = Line::from(info_spans);

    let info = Paragraph::new(info_line).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER)),
    );
    f.render_widget(info, header_chunks[0]);

    let active_tab = match app.main_view {
        MainView::Activity => 0,
        MainView::Plan => 1,
        MainView::Stats => 2,
        MainView::Diff | MainView::Decisions => 3,
    };
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
        Span::raw("  "),
        Span::styled(
            "4:Changes",
            if active_tab == 3 {
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

// --- Shared: Status Bar ---
// Full-width run status, mirroring the web run-view bar:
//   ● status · elapsed · agents · tokens · files [· cost] · repo [· runner] [· branch] [· PR]

fn render_status_bar(f: &mut Frame, app: &App, area: Rect) {
    let counts = count_stories(app);
    let elapsed = app.elapsed_secs();

    let (word, color) = if app.done {
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
    };

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

// --- Changes tab: files touched + colored diff ---

fn render_changes(f: &mut Frame, app: &App, area: Rect) {
    if app.changed_files.is_empty() {
        let p = Paragraph::new(Line::from(Span::styled(
            "  No changes yet — diffs appear here as stories merge into the run branch.",
            Style::default().fg(theme::MUTED),
        )))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    " Changes ",
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                )),
        );
        f.render_widget(p, area);
        return;
    }

    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(38), Constraint::Percentage(62)])
        .split(area);

    // Left: changed files with +added / -removed counts.
    let file_lines: Vec<Line> = app
        .changed_files
        .iter()
        .map(|fch| {
            Line::from(vec![
                Span::styled(format!("+{}", fch.added), Style::default().fg(theme::SUCCESS)),
                Span::raw(" "),
                Span::styled(format!("-{}", fch.removed), Style::default().fg(theme::ERROR)),
                Span::raw("  "),
                Span::styled(fch.path.clone(), Style::default().fg(theme::TEXT)),
            ])
        })
        .collect();
    let files_panel = Paragraph::new(file_lines).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER))
            .title(Span::styled(
                format!(" Changes ({}) ", app.changed_files.len()),
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
            )),
    );
    f.render_widget(files_panel, cols[0]);

    // Right: per-story unified diff, colored like the web demo (additions green,
    // deletions red, hunk headers amber). Stable order by story id.
    let mut diffs: Vec<(&String, &String)> = app.story_diffs.iter().collect();
    diffs.sort_by(|a, b| a.0.cmp(b.0));
    let mut diff_lines: Vec<Line> = Vec::new();
    for (sid, text) in diffs {
        diff_lines.push(Line::from(Span::styled(
            format!("\u{258C} {}", sid),
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        )));
        for raw in text.lines() {
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
            diff_lines.push(Line::from(Span::styled(raw.to_string(), style)));
        }
        diff_lines.push(Line::from(""));
    }
    let diff_panel = Paragraph::new(diff_lines).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER))
            .title(Span::styled(
                " Diff ",
                Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
            )),
    );
    f.render_widget(diff_panel, cols[1]);
}

// --- Shared: Footer ---

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let msg = if app.finalize_in_progress {
        " Finalizing...".to_string()
    } else if app.done {
        let stats = app.final_stats.as_ref();
        let completed = stats.map(|s| s.stories_completed).unwrap_or(0);
        // Orchestrator field is `stories_skipped` for protocol-compat,
        // but it counts failed + dropped. Show as "failed" — that's what
        // it actually represents to the user (a story that was attempted
        // but didn't make it green, or was dropped after dependency
        // failure).
        let failed = stats.map(|s| s.stories_skipped).unwrap_or(0);
        let elapsed = app.total_time_secs;
        format!(
            " Done! {} completed, {} failed in {}:{:02} | q:exit",
            completed,
            failed,
            elapsed / 60,
            elapsed % 60,
        )
    } else {
        " 1/2/3:tabs | Tab/Shift+Tab:logs | \u{2191}\u{2193}:scroll | q:quit".to_string()
    };

    let footer = Paragraph::new(Span::styled(msg, Style::default().fg(theme::MUTED)));
    f.render_widget(footer, area);
}

