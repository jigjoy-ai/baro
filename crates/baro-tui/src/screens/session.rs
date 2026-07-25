//! Session screen: the chat-first spine (v2). One scrolling transcript —
//! conversation turns, then live run blocks — a persistent input, and a
//! one-line status footer. The workbench remains one Tab away.

use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{App, StoryStatus};
use crate::conversation::{ConversationPhase, TranscriptRole};
use crate::session_feed::SessionBlock;
use crate::theme;
use crate::utils::format_commas;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(5),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);

    frame.render_widget(header_line(app), chunks[0]);

    let width = chunks[1].width.saturating_sub(2) as usize;
    let mut lines: Vec<Line> = Vec::new();
    transcript_lines(app, &mut lines);
    feed_lines(app, width, &mut lines);

    let visible = chunks[1].height as usize;
    let tail = lines.len().saturating_sub(visible);
    let start = tail.saturating_sub(app.session_feed.scroll_back);
    let transcript = Paragraph::new(lines.into_iter().skip(start).collect::<Vec<_>>())
        .wrap(Wrap { trim: false });
    frame.render_widget(transcript, chunks[1]);

    frame.render_widget(input_box(app), chunks[2]);
    frame.render_widget(footer_line(app), chunks[3]);
}

fn header_line(app: &App) -> Paragraph<'static> {
    let phase = match app.conversation.phase() {
        ConversationPhase::Clarifying => "listening",
        ConversationPhase::NeedsInput => "needs input",
        ConversationPhase::Ready => "goal ready",
        ConversationPhase::Planning => "planning",
        ConversationPhase::Executing => "executing",
        ConversationPhase::Verifying => "verifying",
        ConversationPhase::Completed => "ready for follow-up",
        ConversationPhase::Failed => "run failed",
    };
    let mut spans = vec![
        Span::styled(
            " baro ",
            Style::default()
                .fg(theme::ACCENT_BRIGHT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("· ", Style::default().fg(theme::MUTED)),
        Span::styled(phase.to_string(), Style::default().fg(theme::ACCENT)),
    ];
    if !app.stories.is_empty() {
        let done = app
            .stories
            .iter()
            .filter(|s| s.status == StoryStatus::Complete)
            .count();
        spans.push(Span::styled(
            format!("  {}/{} stories", done, app.stories.len()),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }
    let tokens = app.total_input_tokens + app.total_output_tokens;
    if tokens > 0 {
        spans.push(Span::styled(
            format!("  {} tok", format_commas(tokens)),
            Style::default().fg(theme::TEXT_DIM),
        ));
    }
    Paragraph::new(Line::from(spans))
}

fn transcript_lines(app: &App, lines: &mut Vec<Line<'static>>) {
    if app.conversation.transcript().is_empty() && app.session_feed.blocks().is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled(
                "  Baro  ",
                Style::default()
                    .fg(theme::ACCENT_BRIGHT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "What do you want to build or change?",
                Style::default().fg(theme::TEXT),
            ),
        ]));
        return;
    }
    let done_in_feed = app
        .session_feed
        .blocks()
        .iter()
        .any(|b| matches!(b, SessionBlock::Done { .. }));
    for turn in app.conversation.transcript() {
        // The Done block already renders the run summary in place; the
        // durable system turn only matters for restored sessions.
        if done_in_feed
            && turn.role == TranscriptRole::System
            && (turn.text.starts_with("Run completed") || turn.text.starts_with("Run stopped"))
        {
            continue;
        }
        let (label, style) = match turn.role {
            TranscriptRole::User => (
                "You",
                Style::default()
                    .fg(theme::SUCCESS)
                    .add_modifier(Modifier::BOLD),
            ),
            TranscriptRole::Assistant => (
                "Baro",
                Style::default()
                    .fg(theme::ACCENT_BRIGHT)
                    .add_modifier(Modifier::BOLD),
            ),
            TranscriptRole::System => ("·", Style::default().fg(theme::MUTED)),
        };
        for (index, text) in turn.text.lines().enumerate() {
            lines.push(Line::from(vec![
                Span::styled(
                    if index == 0 {
                        format!("  {label:<5}")
                    } else {
                        "       ".to_string()
                    },
                    style,
                ),
                Span::styled(text.to_string(), Style::default().fg(theme::TEXT)),
            ]));
        }
        lines.push(Line::from(""));
    }
}

fn feed_lines(app: &App, width: usize, lines: &mut Vec<Line<'static>>) {
    for block in app.session_feed.blocks() {
        match block {
            SessionBlock::PlanReady { total, mode } => {
                lines.push(Line::from(vec![
                    Span::styled("  ◆ ", Style::default().fg(theme::ACCENT)),
                    Span::styled(
                        format!("plan ready — {} stories", total),
                        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        if mode.is_empty() {
                            String::new()
                        } else {
                            format!("  ({mode})")
                        },
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                ]));
                lines.push(Line::from(""));
            }
            SessionBlock::Level { ordinal, story_ids } => {
                lines.push(Line::from(vec![
                    Span::styled("  ─ ", Style::default().fg(theme::MUTED)),
                    Span::styled(
                        format!("level {}", ordinal),
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                    Span::styled(
                        format!("  {}", story_ids.join(" ")),
                        Style::default().fg(theme::MUTED),
                    ),
                ]));
            }
            SessionBlock::Story { id } => lines.push(story_line(app, id, width)),
            SessionBlock::Critique { id, pass, reason } => {
                let (glyph, color) = if *pass {
                    ("✓", theme::SUCCESS)
                } else {
                    ("✗", theme::ERROR)
                };
                let mut spans = vec![
                    Span::styled("    ".to_string(), Style::default()),
                    Span::styled(format!("critic {glyph} "), Style::default().fg(color)),
                    Span::styled(id.clone(), Style::default().fg(theme::TEXT_DIM)),
                ];
                if !*pass && !reason.is_empty() {
                    spans.push(Span::styled(
                        format!(" — {}", clip(reason, width.saturating_sub(16 + id.len()))),
                        Style::default().fg(theme::TEXT_DIM),
                    ));
                }
                lines.push(Line::from(spans));
            }
            SessionBlock::Replan { source, reason } => {
                lines.push(Line::from(vec![
                    Span::styled("  ⟲ ", Style::default().fg(theme::REPLAN)),
                    Span::styled("replan ", Style::default().fg(theme::REPLAN)),
                    Span::styled(
                        format!("({source}) — {}", clip(reason, width.saturating_sub(14))),
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                ]));
            }
            SessionBlock::Merge { id, ok, detail } => {
                let (glyph, color, verb) = if *ok {
                    ("⇂", theme::SUCCESS, "merged")
                } else {
                    ("⇂", theme::ERROR, "merge failed")
                };
                let mut spans = vec![
                    Span::styled(format!("    {glyph} "), Style::default().fg(color)),
                    Span::styled(format!("{id} {verb}"), Style::default().fg(theme::TEXT_DIM)),
                ];
                if let Some(detail) = detail {
                    spans.push(Span::styled(
                        format!(" — {}", clip(detail, width.saturating_sub(20))),
                        Style::default().fg(theme::TEXT_DIM),
                    ));
                }
                lines.push(Line::from(spans));
            }
            SessionBlock::Note { text } => {
                lines.push(Line::from(vec![
                    Span::styled("  ▸ ", Style::default().fg(theme::WARNING)),
                    Span::styled(
                        clip(text, width.saturating_sub(4)),
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                ]));
            }
            SessionBlock::Done { success, summary } => {
                lines.push(Line::from(""));
                let (glyph, color, label) = if *success {
                    ("✓", theme::SUCCESS, "run complete")
                } else {
                    ("✗", theme::ERROR, "run stopped")
                };
                let mut spans = vec![Span::styled(
                    format!("  {glyph} {label}"),
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                )];
                if app.total_time_secs > 0 {
                    spans.push(Span::styled(
                        format!(
                            "  {}:{:02}",
                            app.total_time_secs / 60,
                            app.total_time_secs % 60
                        ),
                        Style::default().fg(theme::TEXT_DIM),
                    ));
                }
                lines.push(Line::from(spans));
                for (key, value) in summary {
                    lines.push(Line::from(Span::styled(
                        format!("    {key}: {}", clip(value, width.saturating_sub(8))),
                        Style::default().fg(theme::TEXT_DIM),
                    )));
                }
                if let Some(stats) = &app.final_stats {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "    files +{} ~{} · commits {}",
                            stats.files_created, stats.files_modified, stats.total_commits
                        ),
                        Style::default().fg(theme::TEXT_DIM),
                    )));
                }
                if let Some(pr) = &app.pr_url {
                    lines.push(Line::from(vec![
                        Span::styled("    PR ", Style::default().fg(theme::TEXT_DIM)),
                        Span::styled(pr.clone(), Style::default().fg(theme::ACCENT)),
                    ]));
                }
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled("  › ", Style::default().fg(theme::ACCENT)),
                    Span::styled(
                        "What next? ",
                        Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        "Type to ask about the run or start the next iteration",
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                ]));
                let mut hints = vec![Span::styled(
                    "    tab review changes",
                    Style::default().fg(theme::TEXT_DIM),
                )];
                if app.pr_url.is_some() {
                    hints.push(Span::styled(
                        "  ·  ctrl+p open PR",
                        Style::default().fg(theme::TEXT_DIM),
                    ));
                }
                hints.push(Span::styled(
                    "  ·  esc quit",
                    Style::default().fg(theme::TEXT_DIM),
                ));
                lines.push(Line::from(hints));
            }
        }
    }
}

/// One live line per story, claude-code tool-line style: glyph, id, title,
/// route badge, elapsed/duration, tail of the latest activity.
fn story_line(app: &App, id: &str, width: usize) -> Line<'static> {
    let story = app.stories.iter().find(|s| s.id == id);
    let status = story.map(|s| s.status.clone()).unwrap_or(StoryStatus::Pending);
    let (glyph, color) = match status {
        StoryStatus::Running => (
            SPINNER[(app.tick_count as usize / 2) % SPINNER.len()],
            theme::ACCENT,
        ),
        StoryStatus::Complete => ("✓", theme::SUCCESS),
        StoryStatus::Failed => ("✗", theme::ERROR),
        StoryStatus::Retrying(_) => ("↻", theme::WARNING),
        StoryStatus::Skipped => ("⊘", theme::MUTED),
        StoryStatus::Pending => ("○", theme::MUTED),
    };
    let title = story.map(|s| s.title.clone()).unwrap_or_default();
    let route = story.and_then(|s| s.route.clone());
    let mut spans = vec![
        Span::styled(format!("  {glyph} "), Style::default().fg(color)),
        Span::styled(
            format!("{id} "),
            Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            clip(&title, width.saturating_sub(30)),
            Style::default().fg(theme::TEXT),
        ),
    ];
    if let Some(route) = route {
        spans.push(Span::styled(
            format!("  [{route}]"),
            Style::default().fg(theme::ACCENT_DIM),
        ));
    }
    match status {
        StoryStatus::Running => {
            if let Some(active) = app.active_stories.get(id) {
                let secs = active.start_time.elapsed().as_secs();
                spans.push(Span::styled(
                    format!("  {}:{:02}", secs / 60, secs % 60),
                    Style::default().fg(theme::TEXT_DIM),
                ));
                if let Some(entry) =
                    active.activity.iter().rev().find(|e| !e.system)
                {
                    spans.push(Span::styled(
                        format!("  {}", clip(&entry.text, width.saturating_sub(40))),
                        Style::default().fg(theme::TEXT_DIM),
                    ));
                }
            }
        }
        StoryStatus::Complete => {
            if let Some(secs) = story.and_then(|s| s.duration_secs) {
                spans.push(Span::styled(
                    format!("  {}:{:02}", secs / 60, secs % 60),
                    Style::default().fg(theme::TEXT_DIM),
                ));
            }
        }
        _ => {}
    }
    Line::from(spans)
}

fn input_box(app: &App) -> Paragraph<'static> {
    let text = if app.conversation_busy {
        format!(
            " {} thinking…",
            SPINNER[(app.tick_count as usize / 2) % SPINNER.len()]
        )
    } else if app.conversation_input.is_empty() {
        match app.conversation.phase() {
            ConversationPhase::Executing | ConversationPhase::Verifying => {
                " Message baro — @S1 targets an agent…".to_string()
            }
            ConversationPhase::Completed | ConversationPhase::Failed => {
                " Ask what was done, or describe the next iteration…".to_string()
            }
            _ => " Type a goal, answer, or follow-up…".to_string(),
        }
    } else {
        format!(" {}█", app.conversation_input)
    };
    let border = if app.conversation_error.is_some() {
        theme::ERROR
    } else if app.conversation_busy {
        theme::ACCENT_DIM
    } else {
        theme::BORDER_ACTIVE
    };
    Paragraph::new(text).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border)),
    )
}

fn footer_line(app: &App) -> Paragraph<'static> {
    if let Some(error) = &app.conversation_error {
        return Paragraph::new(Line::from(vec![
            Span::styled(" error: ", Style::default().fg(theme::ERROR)),
            Span::styled(clip(error, 120), Style::default().fg(theme::TEXT_DIM)),
        ]));
    }
    Paragraph::new(Line::from(vec![
        Span::styled(" enter", Style::default().fg(theme::ACCENT)),
        Span::styled(" send  ", Style::default().fg(theme::MUTED)),
        Span::styled("tab", Style::default().fg(theme::ACCENT)),
        Span::styled(" workbench  ", Style::default().fg(theme::MUTED)),
        Span::styled("↑↓", Style::default().fg(theme::ACCENT)),
        Span::styled(" scroll  ", Style::default().fg(theme::MUTED)),
        Span::styled("esc", Style::default().fg(theme::ACCENT)),
        Span::styled(" quit  ·  ", Style::default().fg(theme::MUTED)),
        Span::styled(
            app.llm.as_str().to_string(),
            Style::default().fg(theme::ACCENT),
        ),
    ]))
}

fn clip(value: &str, max: usize) -> String {
    let max = max.max(8);
    if value.chars().count() <= max {
        value.to_string()
    } else {
        value.chars().take(max - 1).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};



    #[test]
    fn session_renders_conversation_and_run_blocks_at_all_sizes() {
        use crate::session_feed::SessionBlock;
        for (width, height) in [(40, 12), (80, 24), (140, 40)] {
            let mut app = App::new();
            app.start_conversation();
            app.session_feed.push(SessionBlock::PlanReady {
                total: 2,
                mode: "parallel".into(),
            });
            app.session_feed.push(SessionBlock::Level {
                ordinal: 0,
                story_ids: vec!["S1".into()],
            });
            app.session_feed.push(SessionBlock::Story { id: "S1".into() });
            app.session_feed.push(SessionBlock::Critique {
                id: "S1".into(),
                pass: true,
                reason: String::new(),
            });
            app.session_feed.push(SessionBlock::Merge {
                id: "S1".into(),
                ok: true,
                detail: None,
            });
            app.session_feed.push(SessionBlock::Done {
                success: true,
                summary: vec![("stopped".into(), "never".into())],
            });
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|frame| render(frame, &app)).unwrap();
        }
    }
}
