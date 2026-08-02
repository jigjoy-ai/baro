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
    let input_height =
        (app.conversation_input.lines().count().max(1).min(4) as u16) + 2;
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(5),
            Constraint::Length(input_height),
            Constraint::Length(1),
        ])
        .split(area);

    frame.render_widget(header_line(app), chunks[0]);

    let width = chunks[1].width.saturating_sub(2) as usize;
    // Rebuild + re-measure only when content (or width) changed: wheel
    // frames between events render straight from the cache.
    thread_local! {
        static CACHE: std::cell::RefCell<Option<(u64, u16, Vec<Line<'static>>, usize)>> =
            const { std::cell::RefCell::new(None) };
    }
    let (lines, total) = CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some((version, cached_width, lines, total)) = cache.as_ref() {
            if *version == app.session_version && *cached_width == chunks[1].width {
                return (lines.clone(), *total);
            }
        }
        let mut lines: Vec<Line> = Vec::new();
        interleaved_lines(app, width, &mut lines);
        streaming_lines(app, &mut lines);
        planning_lines(app, width, &mut lines);
        let total = Paragraph::new(lines.clone())
            .wrap(Wrap { trim: false })
            .line_count(chunks[1].width);
        *cache = Some((app.session_version, chunks[1].width, lines.clone(), total));
        (lines, total)
    });

    // Scroll in wrapped visual rows so long lines don't cause jumps.
    let visible = chunks[1].height as usize;
    let max_back = total.saturating_sub(visible);
    let back = app.session_feed.scroll_back.min(max_back);
    if let Some(id) = &app.focused_story {
        render_focus(frame, app, id, chunks[1]);
    } else {
        let transcript = Paragraph::new(lines).wrap(Wrap { trim: false });
        let offset = max_back.saturating_sub(back);
        let transcript = transcript.scroll((offset as u16, 0));
        frame.render_widget(transcript, chunks[1]);
    }

    frame.render_widget(input_box(app), chunks[2]);
    frame.render_widget(footer_line(app, back > 0), chunks[3]);
}

/// Inline drill-in: one agent's full activity tail over the transcript
/// area. ctrl+o cycles agents, esc returns to the session.
fn render_focus(frame: &mut Frame, app: &App, id: &str, area: ratatui::layout::Rect) {
    let mut lines: Vec<Line> = Vec::new();
    let story = app.stories.iter().find(|s| s.id == id);
    let title = story.map(|s| s.title.as_str()).unwrap_or("");
    let route = story
        .and_then(|s| s.route.as_deref())
        .map(|r| format!("  [{r}]"))
        .unwrap_or_default();
    lines.push(Line::from(vec![
        Span::styled(
            format!("  ◉ {id} "),
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(title.to_string(), Style::default().fg(theme::TEXT)),
        Span::styled(route, Style::default().fg(theme::ACCENT_DIM)),
        Span::styled(
            "   esc back · ctrl+o next agent",
            Style::default().fg(theme::MUTED),
        ),
    ]));
    let header_rows = 2u16.min(area.height);
    let header_area = ratatui::layout::Rect { height: header_rows, ..area };
    let body_area = ratatui::layout::Rect {
        y: area.y + header_rows,
        height: area.height.saturating_sub(header_rows),
        ..area
    };
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), header_area);

    // Scrollable body: the agent's full retained activity, wheel/PageUp to
    // look back, tail-follow when at the bottom. Recent 500 entries bound
    // the per-frame build cost.
    let mut body: Vec<Line> = Vec::new();
    if let Some(active) = app.active_stories.get(id) {
        let entries: Vec<&crate::app::ActivityEntry> =
            active.activity.iter().rev().take(500).rev().collect();
        if entries.is_empty() {
            for log in active.logs.iter().rev().take(500).rev() {
                body.push(Line::from(Span::styled(
                    format!("  {log}"),
                    Style::default().fg(theme::TEXT_DIM),
                )));
            }
        } else {
            let width = area.width.saturating_sub(4) as usize;
            for entry in entries {
                body.push(crate::screens::widgets::activity_line(entry, width));
            }
        }
    } else {
        body.push(Line::from(Span::styled(
            "  (no live worker for this story right now)",
            Style::default().fg(theme::MUTED),
        )));
    }
    let paragraph = Paragraph::new(body).wrap(Wrap { trim: false });
    let total = paragraph.line_count(body_area.width);
    let visible = body_area.height as usize;
    let max_back = total.saturating_sub(visible);
    let back = app.focus_scroll_back.min(max_back);
    let offset = max_back.saturating_sub(back);
    frame.render_widget(paragraph.scroll((offset as u16, 0)), body_area);
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

/// Merge conversation turns and run blocks by their shared sequence
/// clock, so mid-run chat renders between the story lines it happened
/// around instead of above the whole run.
fn interleaved_lines(app: &App, width: usize, lines: &mut Vec<Line<'static>>) {
    if app.conversation.transcript().is_empty() && app.session_feed.sequenced().is_empty() {
        greeting_lines(lines);
        return;
    }
    let turns = app.conversation.transcript();
    let seqs = &app.transcript_seqs;
    let blocks = app.session_feed.sequenced();
    let mut turn_ix = 0;
    let mut block_ix = 0;
    while turn_ix < turns.len() || block_ix < blocks.len() {
        let turn_seq = seqs.get(turn_ix).copied().unwrap_or(u64::MAX);
        let block_seq = blocks
            .get(block_ix)
            .map(|(seq, _)| *seq)
            .unwrap_or(u64::MAX);
        if turn_ix < turns.len() && turn_seq <= block_seq {
            turn_lines(app, &turns[turn_ix], lines);
            turn_ix += 1;
        } else {
            block_lines(app, &blocks[block_ix].1, width, lines);
            block_ix += 1;
        }
    }
}

fn greeting_lines(lines: &mut Vec<Line<'static>>) {
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  What do you want to build or change?",
        Style::default().fg(theme::TEXT),
    )));
}

fn turn_lines(
    app: &App,
    turn: &crate::conversation::TranscriptTurn,
    lines: &mut Vec<Line<'static>>,
) {
    // The Done block already renders the run summary in place; the
    // durable system turn only matters for restored sessions.
    let done_in_feed = app
        .session_feed
        .blocks()
        .any(|b| matches!(b, SessionBlock::Done { .. }));
    if done_in_feed
        && turn.role == TranscriptRole::System
        && (turn.text.starts_with("Run completed") || turn.text.starts_with("Run stopped"))
    {
        return;
    }
    match turn.role {
        TranscriptRole::Assistant => {
            markdown_lines(&turn.text, "  ", lines);
        }
        TranscriptRole::User => {
            for (index, text) in turn.text.lines().enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(
                        if index == 0 { "› " } else { "  " }.to_string(),
                        Style::default().fg(theme::ACCENT),
                    ),
                    Span::styled(
                        text.to_string(),
                        Style::default().fg(theme::TEXT_DIM),
                    ),
                ]));
            }
        }
        TranscriptRole::System => {
            for text in turn.text.lines() {
                lines.push(Line::from(vec![
                    Span::styled("· ".to_string(), Style::default().fg(theme::MUTED)),
                    Span::styled(
                        text.to_string(),
                        Style::default().fg(theme::MUTED),
                    ),
                ]));
            }
        }
    }
    lines.push(Line::from(""));
}

/// The assistant's reply as it is being composed (conversation_delta),
/// or a contextual thinking line while nothing has streamed yet.
fn streaming_lines(app: &App, lines: &mut Vec<Line<'static>>) {
    let streamed = match &app.conversation_stream {
        Some((_, text)) if !text.is_empty() => {
            markdown_lines(text, "  ", lines);
            lines.push(Line::from(""));
            true
        }
        _ => false,
    };
    // The turn stays busy after the reply finishes streaming (runner
    // shutdown, billing, the architect handoff) — keep a live indicator
    // under the text so a complete-looking reply never reads as stalled.
    if app.conversation_busy {
        let status = if app.architect_status == crate::app::ArchitectStatus::Running {
            "validating the goal against the repository…"
        } else if streamed {
            "working…"
        } else {
            "thinking…"
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!(
                    "  {} ",
                    SPINNER[(app.tick_count as usize / 2) % SPINNER.len()]
                ),
                Style::default().fg(theme::ACCENT),
            ),
            Span::styled(status.to_string(), Style::default().fg(theme::TEXT_DIM)),
        ]));
    }
}

fn block_lines(
    app: &App,
    block: &SessionBlock,
    width: usize,
    lines: &mut Vec<Line<'static>>,
) {
    {
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
                ]));
                for id in story_ids {
                    lines.push(story_line(app, id, width));
                }
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
                let completed = app
                    .stories
                    .iter()
                    .filter(|s| matches!(s.status, crate::app::StoryStatus::Complete))
                    .count();
                if !app.stories.is_empty() {
                    lines.push(Line::from(Span::styled(
                        format!("    stories {completed}/{}", app.stories.len()),
                        Style::default().fg(theme::TEXT_DIM),
                    )));
                }
                if let Some(status) = app.verification_status.as_deref() {
                    let (label, color) = match status {
                        "passed" => ("passed", theme::SUCCESS),
                        "failed" => ("failed", theme::ERROR),
                        _ => ("not run", theme::WARNING),
                    };
                    let detail = app
                        .verification
                        .as_ref()
                        .map(|e| {
                            format!(
                                " · {} command(s) · {:.1}s",
                                e.commands.len(),
                                e.duration_ms as f64 / 1_000.0
                            )
                        })
                        .unwrap_or_default();
                    lines.push(Line::from(vec![
                        Span::styled(
                            "    verification ".to_string(),
                            Style::default().fg(theme::TEXT_DIM),
                        ),
                        Span::styled(label.to_string(), Style::default().fg(color)),
                        Span::styled(detail, Style::default().fg(theme::TEXT_DIM)),
                    ]));
                }
                let (saved_secs, multiplier) = app.parallel_time_saved();
                if saved_secs > 0 {
                    lines.push(Line::from(vec![
                        Span::styled(
                            "    time saved ".to_string(),
                            Style::default().fg(theme::TEXT_DIM),
                        ),
                        Span::styled(
                            format!(
                                "{}:{:02} with parallel execution ({multiplier:.1}x)",
                                saved_secs / 60,
                                saved_secs % 60
                            ),
                            Style::default().fg(theme::SUCCESS),
                        ),
                    ]));
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
                if app.total_input_tokens > 0 || app.total_output_tokens > 0 {
                    let mut usage = format!(
                        "    tokens {} in / {} out",
                        crate::utils::format_commas(app.total_input_tokens),
                        crate::utils::format_commas(app.total_output_tokens)
                    );
                    if app.total_cost_usd > 0.0 {
                        usage.push_str(&format!(" · ${:.2}", app.total_cost_usd));
                    }
                    lines.push(Line::from(Span::styled(
                        usage,
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
                } else {
                    hints.push(Span::styled(
                        "  ·  ctrl+g publish to GitHub",
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
        StoryStatus::Pending => {
            let deps_done = story.is_some_and(|s| {
                s.depends_on.iter().all(|dep| {
                    app.stories
                        .iter()
                        .find(|other| &other.id == dep)
                        .is_some_and(|other| other.status == StoryStatus::Complete)
                })
            });
            spans.push(Span::styled(
                if deps_done {
                    "  matching a worker…"
                } else {
                    "  waiting on deps"
                }
                .to_string(),
                Style::default().fg(theme::MUTED),
            ));
        }
        _ => {}
    }
    Line::from(spans)
}

/// Live planning status and the inline plan-confirmation block.
fn planning_lines(app: &App, width: usize, lines: &mut Vec<Line<'static>>) {
    if app.inline_mode_pick {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  ◆ ", Style::default().fg(theme::ACCENT)),
            Span::styled(
                "pick an execution mode",
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]));
        for (i, mode) in crate::app::MODE_OPTIONS.iter().enumerate() {
            let selected = app.mode_picker_index == i;
            let suggested = app
                .mode_proposal
                .as_ref()
                .is_some_and(|p| p.mode == *mode);
            let mut spans = vec![
                Span::styled(
                    if selected { "    ▶ " } else { "      " }.to_string(),
                    Style::default().fg(theme::ACCENT),
                ),
                Span::styled(
                    format!("{:<11}", crate::screens::mode_picker::mode_title(mode)),
                    if selected {
                        Style::default()
                            .fg(theme::ACCENT_BRIGHT)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(theme::TEXT_DIM)
                    },
                ),
                Span::styled(
                    clip(
                        crate::screens::mode_picker::mode_description(mode),
                        width.saturating_sub(32),
                    ),
                    Style::default().fg(theme::MUTED),
                ),
            ];
            if suggested {
                spans.push(Span::styled(
                    "  (suggested)",
                    Style::default().fg(theme::SUCCESS),
                ));
            }
            lines.push(Line::from(spans));
        }
        if let Some(p) = &app.mode_proposal {
            lines.push(Line::from(Span::styled(
                clip(
                    &format!(
                        "    Baro suggests {} ({:.0}%): {}",
                        crate::screens::mode_picker::mode_title(&p.mode),
                        p.confidence * 100.0,
                        p.reason
                    ),
                    width.saturating_sub(4),
                ),
                Style::default().fg(theme::TEXT_DIM),
            )));
        }
        lines.push(Line::from(vec![
            Span::styled("  › ", Style::default().fg(theme::ACCENT)),
            Span::styled("↑/↓", Style::default().fg(theme::ACCENT)),
            Span::styled(" choose  ·  ", Style::default().fg(theme::TEXT_DIM)),
            Span::styled("enter", Style::default().fg(theme::ACCENT)),
            Span::styled(" confirm", Style::default().fg(theme::TEXT_DIM)),
        ]));
        return;
    }
    if let Some(stories) = &app.pending_plan {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("  ◆ ", Style::default().fg(theme::ACCENT)),
            Span::styled(
                format!("plan ready — {} stories", stories.len()),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]));
        const VISIBLE: usize = 8;
        for story in stories.iter().take(VISIBLE) {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("    ○ {} ", story.id),
                    Style::default().fg(theme::TEXT_DIM),
                ),
                Span::styled(
                    clip(&story.title, width.saturating_sub(12)),
                    Style::default().fg(theme::TEXT),
                ),
            ]));
        }
        if stories.len() > VISIBLE {
            lines.push(Line::from(Span::styled(
                format!("    … and {} more", stories.len() - VISIBLE),
                Style::default().fg(theme::MUTED),
            )));
        }
        lines.push(Line::from(vec![
            Span::styled("  › ", Style::default().fg(theme::ACCENT)),
            Span::styled("enter", Style::default().fg(theme::ACCENT)),
            Span::styled(" run the plan  ·  ", Style::default().fg(theme::TEXT_DIM)),
            Span::styled("v", Style::default().fg(theme::ACCENT)),
            Span::styled(" detailed review", Style::default().fg(theme::TEXT_DIM)),
        ]));
        return;
    }
    let architect_running =
        app.architect_status == crate::app::ArchitectStatus::Running;
    if app.conversation.phase() == ConversationPhase::Planning || architect_running {
        let mut spans = vec![
            Span::styled(
                format!(
                    "  {} ",
                    SPINNER[(app.tick_count as usize / 2) % SPINNER.len()]
                ),
                Style::default().fg(theme::ACCENT),
            ),
            Span::styled(
                if architect_running {
                    "architect is validating the goal…"
                } else {
                    "architect & planner are working…"
                },
                Style::default().fg(theme::TEXT_DIM),
            ),
        ];
        if let Some(progress) = &app.planning_progress {
            spans.push(Span::styled(
                format!("  {}", clip(progress, width.saturating_sub(36))),
                Style::default().fg(theme::MUTED),
            ));
        }
        lines.push(Line::from(spans));
        // The planning feed's tail: what the architect/planner agents are
        // actually doing right now.
        if let Some(plan) = app.active_stories.get("plan") {
            for line in plan.logs.iter().rev().take(3).rev() {
                lines.push(Line::from(Span::styled(
                    format!("      {}", clip(line, width.saturating_sub(8))),
                    Style::default().fg(theme::MUTED),
                )));
            }
        }
    }
}

fn input_box(app: &App) -> Paragraph<'static> {
    let text = if app.conversation_busy && app.conversation_input.is_empty() {
        " Baro is working — you can keep typing…".to_string()
    } else if app.conversation_input.is_empty() {
        if app.inline_mode_pick {
            return Paragraph::new(" ↑/↓ choose an execution mode · enter confirms")
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(theme::BORDER_ACTIVE)),
                );
        }
        if app.pending_plan.is_some() {
            return Paragraph::new(" Enter runs the plan · v opens detailed review")
                .wrap(Wrap { trim: false })
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(theme::BORDER_ACTIVE)),
                );
        }
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
        String::new() // rendered as spans below for an inline cursor
    };
    let border = if app.conversation_error.is_some() {
        theme::ERROR
    } else if app.conversation_busy {
        theme::ACCENT_DIM
    } else {
        theme::BORDER_ACTIVE
    };
    let content: ratatui::text::Text = if text.is_empty()
        && !app.conversation_input.is_empty()
    {
        input_with_cursor(app)
    } else {
        text.into()
    };
    Paragraph::new(content).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border)),
    )
}

/// The typed text with a reversed-block cursor at the cursor position.
fn input_with_cursor(app: &App) -> ratatui::text::Text<'static> {
    let chars: Vec<char> = app.conversation_input.chars().collect();
    let at = app.conversation_cursor.min(chars.len());
    let before: String = chars[..at].iter().collect();
    let (cursor_ch, after): (String, String) = if at < chars.len() {
        (
            chars[at].to_string(),
            chars[at + 1..].iter().collect(),
        )
    } else {
        (" ".to_string(), String::new())
    };
    let mut lines: Vec<Line> = Vec::new();
    let mut current: Vec<Span> = vec![Span::raw(" ")];
    let mut push_text = |segment: &str, style: Style, lines: &mut Vec<Line<'static>>, current: &mut Vec<Span<'static>>| {
        let mut first = true;
        for part in segment.split('\n') {
            if !first {
                lines.push(Line::from(std::mem::take(current)));
                current.push(Span::raw(" "));
            }
            first = false;
            if !part.is_empty() {
                current.push(Span::styled(part.to_string(), style));
            }
        }
    };
    let plain = Style::default().fg(theme::TEXT);
    let cursor = Style::default().fg(theme::BG).bg(theme::ACCENT);
    push_text(&before, plain, &mut lines, &mut current);
    if cursor_ch == "\n" {
        current.push(Span::styled(" ".to_string(), cursor));
        lines.push(Line::from(std::mem::take(&mut current)));
        current.push(Span::raw(" "));
    } else {
        current.push(Span::styled(cursor_ch, cursor));
    }
    push_text(&after, plain, &mut lines, &mut current);
    lines.push(Line::from(current));
    lines.into()
}

const SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/plan", "review the plan"),
    ("/pr", "open the PR"),
    ("/publish", "create a GitHub repo"),
    ("/agents", "cycle agent drill-in"),
    ("/help", "all commands"),
    ("/quit", "exit baro"),
];

fn footer_line(app: &App, scrolled_back: bool) -> Paragraph<'static> {
    let typed = app.conversation_input.trim_start();
    if typed.starts_with('/') && !typed.contains(char::is_whitespace) {
        let mut spans: Vec<Span> = Vec::new();
        for (name, blurb) in SLASH_COMMANDS
            .iter()
            .filter(|(name, _)| name.starts_with(typed))
        {
            spans.push(Span::styled(
                format!(" {name}"),
                Style::default().fg(theme::ACCENT),
            ));
            spans.push(Span::styled(
                format!(" {blurb}  "),
                Style::default().fg(theme::TEXT_DIM),
            ));
        }
        if !spans.is_empty() {
            return Paragraph::new(Line::from(spans));
        }
    }
    if scrolled_back {
        return Paragraph::new(Line::from(vec![
            Span::styled(" ↓ ", Style::default().fg(theme::WARNING)),
            Span::styled(
                "viewing older activity — ",
                Style::default().fg(theme::TEXT_DIM),
            ),
            Span::styled("end", Style::default().fg(theme::ACCENT)),
            Span::styled(" jumps to live", Style::default().fg(theme::TEXT_DIM)),
        ]));
    }
    if let Some(error) = &app.conversation_error {
        return Paragraph::new(Line::from(vec![
            Span::styled(" error: ", Style::default().fg(theme::ERROR)),
            Span::styled(clip(error, 120), Style::default().fg(theme::TEXT_DIM)),
        ]));
    }
    if app.quit_armed_tick.is_some_and(|armed| app.tick_count.saturating_sub(armed) <= 20) {
        return Paragraph::new(Line::from(vec![
            Span::styled(" ctrl+c", Style::default().fg(theme::WARNING)),
            Span::styled(" again to quit baro", Style::default().fg(theme::TEXT_DIM)),
        ]));
    }
    // While an agent is focused, esc leaves the drill-in — saying "quit" here
    // makes the only way out look like it kills the run.
    let focused = app.focused_story.is_some();
    Paragraph::new(Line::from(vec![
        Span::styled(" enter", Style::default().fg(theme::ACCENT)),
        Span::styled(" send  ", Style::default().fg(theme::MUTED)),
        Span::styled("tab", Style::default().fg(theme::ACCENT)),
        Span::styled(" workbench  ", Style::default().fg(theme::MUTED)),
        Span::styled("↑↓", Style::default().fg(theme::ACCENT)),
        Span::styled(" history  ", Style::default().fg(theme::MUTED)),
        Span::styled("⇞⇟", Style::default().fg(theme::ACCENT)),
        Span::styled(" scroll  ", Style::default().fg(theme::MUTED)),
        Span::styled(
            if focused { "esc" } else { "ctrl+c ×2" },
            Style::default().fg(theme::ACCENT),
        ),
        Span::styled(
            if focused {
                " back to the session  ·  "
            } else {
                " quit  ·  "
            },
            Style::default().fg(theme::MUTED),
        ),
        Span::styled(
            app.llm.as_str().to_string(),
            Style::default().fg(theme::ACCENT),
        ),
    ]))
}

/// Minimal markdown for assistant text: fenced code blocks, bullets,
/// headers, **bold** and `inline code`. Everything else stays prose.
fn markdown_lines(
    text: &str,
    indent: &str,
    lines: &mut Vec<Line<'static>>,
) {
    let mut fence: Option<(String, String)> = None; // (lang, buffered code)
    let mut flush_fence =
        |fence: &mut Option<(String, String)>, lines: &mut Vec<Line<'static>>| {
            let Some((lang, code)) = fence.take() else { return };
            if let Some(highlighted) =
                crate::highlight::highlight_block(&lang, &code, indent)
            {
                lines.extend(highlighted);
                return;
            }
            for raw in code.lines() {
                lines.push(Line::from(vec![
                    Span::raw(indent.to_string()),
                    Span::styled(
                        format!("  {raw}"),
                        Style::default().fg(theme::ACCENT_DIM),
                    ),
                ]));
            }
        };
    for raw in text.lines() {
        let trimmed = raw.trim_start();
        if let Some(tag) = trimmed.strip_prefix("```") {
            if fence.is_some() {
                flush_fence(&mut fence, lines);
            } else {
                fence = Some((tag.trim().to_string(), String::new()));
            }
            continue;
        }
        if let Some((_, code)) = fence.as_mut() {
            code.push_str(raw);
            code.push('\n');
            continue;
        }
        let (prefix, body) = if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("• "))
        {
            ("  • ", rest)
        } else if trimmed.starts_with('#') {
            let body = trimmed.trim_start_matches('#').trim_start();
            lines.push(Line::from(vec![
                Span::raw(indent.to_string()),
                Span::styled(
                    body.to_string(),
                    Style::default()
                        .fg(theme::ACCENT_BRIGHT)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            continue;
        } else {
            ("", trimmed)
        };
        let mut spans: Vec<Span> = vec![Span::raw(indent.to_string())];
        if !prefix.is_empty() {
            spans.push(Span::styled(
                prefix.to_string(),
                Style::default().fg(theme::ACCENT),
            ));
        }
        inline_spans(body, &mut spans);
        lines.push(Line::from(spans));
    }
    flush_fence(&mut fence, lines);
}

/// Split `**bold**` and `` `code` `` runs into styled spans.
fn inline_spans(text: &str, spans: &mut Vec<Span<'static>>) {
    let plain = Style::default().fg(theme::TEXT);
    let bold = Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD);
    let code = Style::default().fg(theme::ACCENT_DIM);
    let mut rest = text;
    loop {
        let next_bold = rest.find("**");
        let next_code = rest.find('`');
        match (next_bold, next_code) {
            (None, None) => {
                if !rest.is_empty() {
                    spans.push(Span::styled(rest.to_string(), plain));
                }
                return;
            }
            (b, c) => {
                let (at, is_bold) = match (b, c) {
                    (Some(b), Some(c)) if b <= c => (b, true),
                    (Some(b), None) => (b, true),
                    (_, Some(c)) => (c, false),
                    _ => unreachable!(),
                };
                let (marker, style): (&str, Style) =
                    if is_bold { ("**", bold) } else { ("`", code) };
                let close = rest[at + marker.len()..].find(marker);
                let Some(close) = close else {
                    spans.push(Span::styled(rest.to_string(), plain));
                    return;
                };
                if at > 0 {
                    spans.push(Span::styled(rest[..at].to_string(), plain));
                }
                let inner =
                    &rest[at + marker.len()..at + marker.len() + close];
                spans.push(Span::styled(inner.to_string(), style));
                rest = &rest[at + marker.len() + close + marker.len()..];
            }
        }
    }
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
            app.pending_plan = Some(vec![crate::app::ReviewStory {
                id: "S9".into(),
                priority: 1,
                title: "Pending plan story".into(),
                description: String::new(),
                depends_on: Vec::new(),
                retries: 1,
                acceptance: Vec::new(),
                tests: Vec::new(),
                goal_invariant_ids: Vec::new(),
                writes: None,
                completed: false,
                model: None,
            }]);
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|frame| render(frame, &app)).unwrap();
        }
    }
}
