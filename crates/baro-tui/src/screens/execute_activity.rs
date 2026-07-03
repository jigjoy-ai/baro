//! Activity main view: structured per-agent feed, optionally pinned to one
//! agent from the explorer.

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Tabs},
    Frame,
};

use crate::app::{App, StoryStatus, WorkbenchFocus};
use crate::screens::widgets::{activity_line, pane_block, truncate_for_panel};
use crate::theme;

const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub fn render_activity(f: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == WorkbenchFocus::Main;

    // Explorer-pinned agent takes over the whole pane (no tab strip).
    if let Some(id) = app.activity_filter.clone() {
        let title = format!(" activity — {} ", id);
        if app.active_stories.contains_key(&id) {
            let block = pane_block(title, focused);
            let inner = block.inner(area);
            f.render_widget(block, area);
            render_feed(f, app, &id, inner);
        } else {
            let status = app
                .stories
                .iter()
                .find(|s| s.id == id)
                .map(|s| status_word(&s.status))
                .unwrap_or("unknown");
            let p = Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    format!("  {} is {} — the live feed only exists while an agent runs.", id, status),
                    Style::default().fg(theme::MUTED),
                )),
                Line::from(Span::styled(
                    "  Esc returns to the running agents.",
                    Style::default().fg(theme::MUTED),
                )),
            ])
            .block(pane_block(title, focused));
            f.render_widget(p, area);
        }
        return;
    }

    let active_ids = app.active_story_ids();

    if active_ids.is_empty() {
        if !app.review_logs.is_empty() {
            render_review_feed(f, app, area, focused);
        } else {
            let msg = if app.done {
                "All done!"
            } else if app.stories.is_empty() {
                "Waiting for events..."
            } else {
                "Waiting for next story..."
            };
            let p = Paragraph::new(Span::styled(msg, Style::default().fg(theme::MUTED)))
                .block(pane_block(" activity ".to_string(), focused));
            f.render_widget(p, area);
        }
        return;
    }

    let selected_id = active_ids
        .get(app.selected_log_index)
        .cloned()
        .unwrap_or_default();

    let block = pane_block(format!(" activity — {} ", selected_id), focused);
    let inner = block.inner(area);
    f.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(2)])
        .split(inner);

    let tab_titles: Vec<Span> = active_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let story = app.active_stories.get(id);
            let title = story.map(|s| s.title.as_str()).unwrap_or(id.as_str());
            let elapsed = story
                .map(|s| s.start_time.elapsed().as_secs())
                .unwrap_or(0);
            let label = format!(" {}:{} {:02}:{:02} ", id, title, elapsed / 60, elapsed % 60);

            if i == app.selected_log_index {
                Span::styled(
                    label,
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                )
            } else {
                Span::styled(label, Style::default().fg(theme::MUTED))
            }
        })
        .collect();

    let log_tabs = Tabs::new(tab_titles)
        .select(app.selected_log_index)
        .style(Style::default().fg(theme::MUTED))
        .highlight_style(
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
        )
        .divider(Span::styled("\u{2502}", Style::default().fg(theme::BORDER)));

    f.render_widget(log_tabs, chunks[0]);
    render_feed(f, app, &selected_id, chunks[1]);
}

/// One story's feed (structured activity preferred, raw logs as fallback)
/// into an already-unwrapped inner rect.
fn render_feed(f: &mut Frame, app: &App, id: &str, inner: Rect) {
    let Some(story) = app.active_stories.get(id) else { return };

    let use_activity = !story.activity.is_empty();
    let total_logs = if use_activity { story.activity.len() } else { story.logs.len() };
    let inner_height = inner.height as usize;
    let tail = total_logs.saturating_sub(inner_height);
    let stored = app.log_scroll_offsets.get(id).copied().unwrap_or(usize::MAX);
    let skip = if stored == usize::MAX { tail } else { stored.min(tail) };
    // Leave the last column for the scrollbar overlay.
    let inner_w = inner.width.saturating_sub(1) as usize;

    let visible_logs: Vec<Line> = if use_activity {
        story.activity[skip..]
            .iter()
            .map(|e| activity_line(e, inner_w))
            .collect()
    } else {
        story.logs[skip..]
            .iter()
            .map(|l| {
                Line::from(Span::styled(
                    format!(" {}", truncate_for_panel(l, inner_w.saturating_sub(1).max(8))),
                    Style::default().fg(theme::TEXT_DIM),
                ))
            })
            .collect()
    };

    f.render_widget(Paragraph::new(visible_logs), inner);

    if total_logs > inner_height {
        let mut scrollbar_state =
            ScrollbarState::new(total_logs.saturating_sub(inner_height)).position(skip);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::ACCENT_DIM));
        f.render_stateful_widget(scrollbar, inner, &mut scrollbar_state);
    }
}

fn render_review_feed(f: &mut Frame, app: &App, area: Rect, focused: bool) {
    let title = if app.review_in_progress {
        let spinner = SPINNER[(app.tick_count as usize) % SPINNER.len()];
        format!(" activity — {} review level {} ", spinner, app.review_level)
    } else {
        format!(" activity — review level {} (done) ", app.review_level)
    };
    let block = pane_block(title, focused);
    let inner = block.inner(area);
    f.render_widget(block, area);

    let total_logs = app.review_logs.len();
    let inner_height = inner.height as usize;
    let tail = total_logs.saturating_sub(inner_height);
    let stored = app.review_log_scroll_offset;
    let skip = if stored == usize::MAX { tail } else { stored.min(tail) };
    let visible_logs: Vec<Line> = app.review_logs[skip..]
        .iter()
        .map(|l| Line::from(Span::styled(l.clone(), Style::default().fg(theme::TEXT))))
        .collect();

    f.render_widget(Paragraph::new(visible_logs), inner);

    if total_logs > inner_height {
        let mut scrollbar_state =
            ScrollbarState::new(total_logs.saturating_sub(inner_height)).position(skip);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::MUTED));
        f.render_stateful_widget(scrollbar, inner, &mut scrollbar_state);
    }
}

fn status_word(status: &StoryStatus) -> &'static str {
    match status {
        StoryStatus::Complete => "complete",
        StoryStatus::Running => "running",
        StoryStatus::Failed => "failed",
        StoryStatus::Retrying(_) => "retrying",
        StoryStatus::Skipped => "dropped",
        StoryStatus::Pending => "pending",
    }
}
