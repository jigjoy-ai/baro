use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{
        Block, Borders, Clear, List, ListItem, Paragraph, Scrollbar, ScrollbarOrientation,
        ScrollbarState, Tabs,
    },
    Frame,
};

use crate::app::App;
use crate::screens::widgets::{activity_line, story_list_item, truncate_for_panel};
use crate::theme;

pub fn render_dashboard(f: &mut Frame, app: &mut App, area: Rect) {
    // Clear the whole dashboard area each frame so stale characters from
    // a prior render — especially on a window resize or when a level
    // header shrinks — get overwritten instead of bleeding through. This
    // is what was producing the "vel 1:" garbled-header look.
    f.render_widget(Clear, area);

    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(35),
            Constraint::Percentage(65),
        ])
        .split(area);

    render_story_list(f, app, main_chunks[0]);
    render_logs(f, app, main_chunks[1]);
}

fn render_story_list(f: &mut Frame, app: &mut App, area: Rect) {
    let mut items: Vec<ListItem> = Vec::new();

    if app.dag_levels.is_empty() {
        for story in &app.stories {
            items.push(story_list_item(story, &app.push_results, 32));
        }
    } else {
        // Inner width of the story list block (panel - 2 borders - 1 for
        // the optional scrollbar). We pad the level header out to this
        // width so any stale characters left over from a prior, longer
        // render frame get overwritten with spaces — without the pad,
        // " Level 1:" sometimes ends up looking like "vel 1:" because
        // an old line at that position still bleeds through.
        let inner_w = area.width.saturating_sub(3) as usize;
        for (i, level) in app.dag_levels.iter().enumerate() {
            let label = format!(" Level {}:", i);
            let pad = inner_w.saturating_sub(label.chars().count());
            items.push(ListItem::new(Line::from(vec![
                Span::styled(
                    label,
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::raw(" ".repeat(pad)),
            ])));

            for story_id in level {
                if let Some(story) = app.stories.iter().find(|s| s.id == *story_id) {
                    items.push(story_list_item(story, &app.push_results, 32));
                }
            }

            // Show review spinner after stories for this level
            if app.review_in_progress && app.review_level == i {
                let spinner_chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
                let spinner = spinner_chars[(app.tick_count as usize) % spinner_chars.len()];
                items.push(ListItem::new(Line::from(Span::styled(
                    format!("   {} Reviewing Level {}...", spinner, i),
                    Style::default().fg(theme::ACCENT),
                ))));
            }

            if i < app.dag_levels.len() - 1 {
                items.push(ListItem::new(Line::from(Span::styled(
                    "   \u{2502}",
                    Style::default().fg(theme::MUTED),
                ))));
            }
        }
    }

    let item_count = items.len();
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    " Agents ",
                    Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                )),
        );
    f.render_stateful_widget(list, area, &mut app.story_list_state);

    // Story list scrollbar
    let inner_height = area.height.saturating_sub(2) as usize;
    if item_count > inner_height {
        let position = app.story_list_state.selected().unwrap_or(0);
        let mut scrollbar_state =
            ScrollbarState::new(item_count.saturating_sub(inner_height)).position(position);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::MUTED));
        f.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
    }
}

fn render_logs(f: &mut Frame, app: &App, area: Rect) {
    let active_ids = app.active_story_ids();

    if active_ids.is_empty() {
        if !app.review_logs.is_empty() {
            let total_logs = app.review_logs.len();
            let inner_height = area.height.saturating_sub(2) as usize;
            let tail = total_logs.saturating_sub(inner_height);
            let stored = app.review_log_scroll_offset;
            let skip = if stored == usize::MAX { tail } else { stored.min(tail) };
            let visible_logs: Vec<Line> = app.review_logs[skip..]
                .iter()
                .map(|l| Line::from(Span::styled(l.clone(), Style::default().fg(theme::TEXT))))
                .collect();

            let title = if app.review_in_progress {
                let spinner_chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
                let spinner = spinner_chars[(app.tick_count as usize) % spinner_chars.len()];
                format!(" {} Review Level {} ", spinner, app.review_level)
            } else {
                format!(" Review Level {} (done) ", app.review_level)
            };

            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::ACCENT))
                .title(Span::styled(
                    title,
                    Style::default()
                        .fg(theme::ACCENT)
                        .add_modifier(Modifier::BOLD),
                ));

            let p = Paragraph::new(visible_logs).block(block);
            f.render_widget(p, area);

            if total_logs > inner_height {
                let mut scrollbar_state =
                    ScrollbarState::new(total_logs.saturating_sub(inner_height)).position(skip);
                let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
                    .style(Style::default().fg(theme::MUTED));
                f.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
            }
        } else {
            let msg = if app.done {
                "All done!"
            } else if app.stories.is_empty() {
                "Waiting for events..."
            } else {
                "Waiting for next story..."
            };

            let p = Paragraph::new(Span::styled(msg, Style::default().fg(theme::MUTED))).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::BORDER))
                    .title(Span::styled(
                        " Activity ",
                        Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
                    )),
            );
            f.render_widget(p, area);
        }
        return;
    }

    let log_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(4),
        ])
        .split(area);

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

    f.render_widget(log_tabs, log_chunks[0]);

    let selected_id = active_ids
        .get(app.selected_log_index)
        .cloned()
        .unwrap_or_default();

    if let Some(story) = app.active_stories.get(&selected_id) {
        // Structured activity is the preferred feed; fall back to raw
        // story_log lines for backends that emit no activity events.
        let use_activity = !story.activity.is_empty();
        let total_logs = if use_activity { story.activity.len() } else { story.logs.len() };
        let inner_height = log_chunks[1].height.saturating_sub(2) as usize;
        let tail = total_logs.saturating_sub(inner_height);
        let stored = app.log_scroll_offsets.get(&selected_id).copied().unwrap_or(usize::MAX);
        let skip = if stored == usize::MAX { tail } else { stored.min(tail) };
        let inner_w = log_chunks[1].width.saturating_sub(3) as usize;
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

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::BORDER_ACTIVE))
            .title(Span::styled(
                format!(" {} ", story.id),
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD),
            ));

        let p = Paragraph::new(visible_logs).block(block);
        f.render_widget(p, log_chunks[1]);

        // Log scrollbar
        if total_logs > inner_height {
            let mut scrollbar_state =
                ScrollbarState::new(total_logs.saturating_sub(inner_height)).position(skip);
            let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
                .style(Style::default().fg(theme::ACCENT_DIM));
            f.render_stateful_widget(scrollbar, log_chunks[1], &mut scrollbar_state);
        }
    }
}
