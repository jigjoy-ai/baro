use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState},
    Frame,
};

use crate::app::{App, LevelRunState, ReplanMark};
use crate::screens::widgets::status_icon_color;
use crate::theme;

pub fn render_dag_full(f: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(""));

    if app.dag_levels.is_empty() {
        lines.push(Line::from(Span::styled(
            "  Waiting for DAG data...",
            Style::default().fg(theme::MUTED),
        )));
    } else {
        for (i, level) in app.dag_levels.iter().enumerate() {
            // Level header with box
            let level_label = format!(" Level {} ", i);
            let story_count = level.len();
            lines.push(Line::from(vec![
                Span::styled("  \u{250c}", Style::default().fg(theme::ACCENT_DIM)),
                Span::styled(
                    "\u{2500}".repeat(level_label.len()),
                    Style::default().fg(theme::ACCENT_DIM),
                ),
                Span::styled("\u{2510}", Style::default().fg(theme::ACCENT_DIM)),
            ]));
            lines.push(Line::from(vec![
                Span::styled("  \u{2502}", Style::default().fg(theme::ACCENT_DIM)),
                Span::styled(
                    level_label.clone(),
                    Style::default()
                        .fg(theme::ACCENT)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("\u{2502}", Style::default().fg(theme::ACCENT_DIM)),
                Span::styled(
                    format!("  {} {}", story_count, if story_count == 1 { "story" } else { "stories" }),
                    Style::default().fg(theme::MUTED),
                ),
                if story_count > 1 {
                    Span::styled(" (parallel)", Style::default().fg(theme::ACCENT_DIM))
                } else {
                    Span::raw("")
                },
                // Level lifecycle from level_started/level_completed; silent
                // until the orchestrator says something.
                match app.level_states.get(&i) {
                    Some(LevelRunState::Running) => {
                        Span::styled("  \u{25CF} running", Style::default().fg(theme::ACCENT))
                    }
                    Some(LevelRunState::Done { failed: false }) => {
                        Span::styled("  ✓ done", Style::default().fg(theme::SUCCESS))
                    }
                    Some(LevelRunState::Done { failed: true }) => {
                        Span::styled("  ✗ failed", Style::default().fg(theme::ERROR))
                    }
                    None => Span::raw(""),
                },
            ]));
            lines.push(Line::from(vec![
                Span::styled("  \u{2514}", Style::default().fg(theme::ACCENT_DIM)),
                Span::styled(
                    "\u{2500}".repeat(level_label.len()),
                    Style::default().fg(theme::ACCENT_DIM),
                ),
                Span::styled("\u{2518}", Style::default().fg(theme::ACCENT_DIM)),
            ]));

            // Stories as cards
            for (j, story_id) in level.iter().enumerate() {
                if let Some(story) = app.stories.iter().find(|s| s.id == *story_id) {
                    let (icon, color) = status_icon_color(&story.status);
                    let duration = story
                        .duration_secs
                        .map(|d| format!(" {}:{:02}", d / 60, d % 60))
                        .unwrap_or_default();

                    // Connector from level box to story
                    let connector = if j == 0 && level.len() == 1 {
                        "  \u{2502}   \u{2514}\u{2500}\u{2500} "
                    } else if j == 0 {
                        "  \u{2502}   \u{251c}\u{2500}\u{2500} "
                    } else if j == level.len() - 1 {
                        "  \u{2502}   \u{2514}\u{2500}\u{2500} "
                    } else {
                        "  \u{2502}   \u{251c}\u{2500}\u{2500} "
                    };

                    let removed_reason = match &story.replan {
                        Some(ReplanMark::Removed(reason)) => Some(reason.clone()),
                        _ => None,
                    };
                    let name_style = if removed_reason.is_some() {
                        Style::default().fg(theme::MUTED).add_modifier(Modifier::CROSSED_OUT)
                    } else {
                        Style::default().fg(color)
                    };

                    let mut spans = vec![
                        Span::styled(connector, Style::default().fg(theme::BORDER)),
                    ];
                    if matches!(story.replan, Some(ReplanMark::Added)) {
                        spans.push(Span::styled("+", Style::default().fg(theme::REPLAN)));
                    }
                    spans.extend([
                        Span::styled(
                            format!("{} ", icon),
                            Style::default().fg(color),
                        ),
                        Span::styled(
                            story.id.to_string(),
                            name_style.add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!(" {}", story.title),
                            name_style,
                        ),
                    ]);

                    if let Some(reason) = &removed_reason {
                        spans.push(Span::styled(
                            format!("  ✂ {}", reason),
                            Style::default().fg(theme::REPLAN),
                        ));
                    }

                    if !duration.is_empty() {
                        spans.push(Span::styled(
                            duration,
                            Style::default().fg(theme::SUCCESS),
                        ));
                    }

                    if !story.depends_on.is_empty() {
                        spans.push(Span::styled(
                            format!("  \u{2190} {}", story.depends_on.join(", ")),
                            Style::default().fg(theme::MUTED),
                        ));
                    }

                    lines.push(Line::from(spans));

                    if let Some(ref err) = story.error {
                        lines.push(Line::from(vec![
                            Span::styled(
                                "  \u{2502}        ",
                                Style::default().fg(theme::BORDER),
                            ),
                            Span::styled(
                                format!("\u{26a0} {}", err),
                                Style::default().fg(theme::ERROR),
                            ),
                        ]));
                    }
                }
            }

            // Arrow between levels
            if i < app.dag_levels.len() - 1 {
                lines.push(Line::from(Span::styled(
                    "  \u{2502}",
                    Style::default().fg(theme::BORDER),
                )));
                lines.push(Line::from(Span::styled(
                    "  \u{25bc}",
                    Style::default().fg(theme::ACCENT_DIM),
                )));
            }

            lines.push(Line::from(""));
        }

        // Recovery levels re-run failed stories after the planned DAG; layout
        // mirrors a level box (3-line header + stories + blank) so the
        // scroll math in dag_line_count stays exact.
        for (attempt, ids) in &app.recoveries {
            let label = format!(" Recovery attempt {} ", attempt);
            lines.push(Line::from(vec![
                Span::styled("  \u{250c}", Style::default().fg(theme::WARNING_DIM)),
                Span::styled(
                    "\u{2500}".repeat(label.len()),
                    Style::default().fg(theme::WARNING_DIM),
                ),
                Span::styled("\u{2510}", Style::default().fg(theme::WARNING_DIM)),
            ]));
            lines.push(Line::from(vec![
                Span::styled("  \u{2502}", Style::default().fg(theme::WARNING_DIM)),
                Span::styled(
                    label.clone(),
                    Style::default().fg(theme::WARNING).add_modifier(Modifier::BOLD),
                ),
                Span::styled("\u{2502}", Style::default().fg(theme::WARNING_DIM)),
                Span::styled(
                    format!(
                        "  {} {}",
                        ids.len(),
                        if ids.len() == 1 { "story" } else { "stories" }
                    ),
                    Style::default().fg(theme::MUTED),
                ),
            ]));
            lines.push(Line::from(vec![
                Span::styled("  \u{2514}", Style::default().fg(theme::WARNING_DIM)),
                Span::styled(
                    "\u{2500}".repeat(label.len()),
                    Style::default().fg(theme::WARNING_DIM),
                ),
                Span::styled("\u{2518}", Style::default().fg(theme::WARNING_DIM)),
            ]));
            for (j, story_id) in ids.iter().enumerate() {
                let connector = if j == ids.len() - 1 {
                    "  \u{2502}   \u{2514}\u{2500}\u{2500} "
                } else {
                    "  \u{2502}   \u{251c}\u{2500}\u{2500} "
                };
                let (icon, color, title) = app
                    .stories
                    .iter()
                    .find(|s| s.id == *story_id)
                    .map(|s| {
                        let (i, c) = status_icon_color(&s.status);
                        (i, c, s.title.clone())
                    })
                    .unwrap_or(("○", theme::MUTED, String::new()));
                lines.push(Line::from(vec![
                    Span::styled(connector, Style::default().fg(theme::BORDER)),
                    Span::styled(format!("{} ", icon), Style::default().fg(color)),
                    Span::styled(
                        story_id.clone(),
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!(" {}", title), Style::default().fg(color)),
                ]));
            }
            lines.push(Line::from(""));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::BORDER))
        .title(Span::styled(
            " Dependency Graph ",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ));

    let total_lines = lines.len();
    let p = Paragraph::new(lines)
        .block(block)
        .scroll((app.dag_scroll_offset, 0));
    f.render_widget(p, area);

    // Scrollbar
    let inner_height = area.height.saturating_sub(2) as usize; // subtract block borders
    if total_lines > inner_height {
        let mut scrollbar_state = ScrollbarState::new(total_lines.saturating_sub(inner_height))
            .position(app.dag_scroll_offset as usize);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::ACCENT_DIM));
        f.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
    }
}
