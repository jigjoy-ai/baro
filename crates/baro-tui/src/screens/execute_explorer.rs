//! Workbench explorer: Agents (story rows grouped by DAG level) stacked
//! over Changes (files accumulated from story_diff events).

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Scrollbar, ScrollbarOrientation, ScrollbarState},
    Frame,
};

use crate::app::{App, WorkbenchFocus};
use crate::screens::widgets::{pane_block, story_list_item};
use crate::theme;

const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub fn render_explorer(f: &mut Frame, app: &mut App, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(60), Constraint::Percentage(40)])
        .split(area);

    render_agents(f, app, chunks[0]);
    render_changes(f, app, chunks[1]);
}

/// Item layout must stay in sync with `App::agent_item_rows` — selection
/// and auto-scroll index through that mirror.
fn render_agents(f: &mut Frame, app: &mut App, area: Rect) {
    let focused = app.focus == WorkbenchFocus::Agents;
    let title_budget = (area.width.saturating_sub(16) as usize).clamp(8, 32);
    let mut items: Vec<ListItem> = Vec::new();

    if app.dag_levels.is_empty() {
        for story in &app.stories {
            items.push(story_list_item(story, &app.push_results, title_budget));
        }
    } else {
        // Pad level headers to the inner width so stale characters from a
        // prior, longer frame get overwritten with spaces.
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
                    items.push(story_list_item(story, &app.push_results, title_budget));
                }
            }

            if app.review_in_progress && app.review_level == i {
                let spinner = SPINNER[(app.tick_count as usize) % SPINNER.len()];
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
    let mut list = List::new(items).block(pane_block(" Agents ".to_string(), focused));
    if focused {
        list = list.highlight_style(Style::default().bg(theme::SELECTION_BG));
    }
    f.render_stateful_widget(list, area, &mut app.story_list_state);

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

fn render_changes(f: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == WorkbenchFocus::Changes;
    let title = format!(" Changes ({}) ", app.changed_files.len());

    if app.changed_files.is_empty() {
        let p = ratatui::widgets::Paragraph::new(Line::from(Span::styled(
            " no diffs yet",
            Style::default().fg(theme::MUTED),
        )))
        .block(pane_block(title, focused));
        f.render_widget(p, area);
        return;
    }

    // "+a -r" prefix is ~10 chars; keep the path tail readable in narrow panes.
    let path_budget = (area.width.saturating_sub(12) as usize).max(8);
    let items: Vec<ListItem> = app
        .changed_files
        .iter()
        .map(|fch| {
            ListItem::new(Line::from(vec![
                Span::styled(format!("+{}", fch.added), Style::default().fg(theme::SUCCESS)),
                Span::raw(" "),
                Span::styled(format!("-{}", fch.removed), Style::default().fg(theme::ERROR)),
                Span::raw(" "),
                Span::styled(
                    truncate_path_tail(&fch.path, path_budget),
                    Style::default().fg(theme::TEXT),
                ),
            ]))
        })
        .collect();

    let item_count = items.len();
    let mut list = List::new(items).block(pane_block(title, focused));
    if focused {
        list = list.highlight_style(Style::default().bg(theme::SELECTION_BG));
    }
    let mut state = ListState::default();
    state.select(Some(app.explorer_file_ix.min(item_count.saturating_sub(1))));
    f.render_stateful_widget(list, area, &mut state);

    let inner_height = area.height.saturating_sub(2) as usize;
    if item_count > inner_height {
        let mut scrollbar_state = ScrollbarState::new(item_count.saturating_sub(inner_height))
            .position(app.explorer_file_ix);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::MUTED));
        f.render_stateful_widget(scrollbar, area, &mut scrollbar_state);
    }
}

/// Truncate keeping the path's *end* — the filename is the signal.
fn truncate_path_tail(path: &str, max: usize) -> String {
    let count = path.chars().count();
    if count <= max {
        return path.to_string();
    }
    let tail: String = path.chars().skip(count - max.saturating_sub(1)).collect();
    format!("…{}", tail)
}
