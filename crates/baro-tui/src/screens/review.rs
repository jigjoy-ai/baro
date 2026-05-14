use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap},
    Frame,
};

use crate::app::App;
use crate::theme;

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Header
            Constraint::Min(8),   // Plan content (scrollable)
            Constraint::Length(1), // Footer
        ])
        .split(area);

    // Header
    let story_count = app.review_stories.len();
    let header_title = if app.is_resume {
        "Resume Review"
    } else {
        "Plan Review"
    };

    let mut header_spans = vec![
        Span::styled(
            " BARO ",
            Style::default()
                .fg(theme::LOGO_1)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" | ", Style::default().fg(theme::BORDER)),
        Span::styled(
            header_title,
            Style::default()
                .fg(theme::TEXT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(" | ", Style::default().fg(theme::BORDER)),
        Span::styled(
            format!("{} stories", story_count),
            Style::default().fg(theme::ACCENT),
        ),
    ];

    if app.is_resume {
        let done_count = app.review_stories.iter().filter(|s| s.completed).count();
        let remaining = story_count - done_count;
        header_spans.push(Span::styled(" | ", Style::default().fg(theme::BORDER)));
        header_spans.push(Span::styled(
            format!("{} done, {} remaining", done_count, remaining),
            Style::default().fg(theme::SUCCESS),
        ));
    }

    let header = Paragraph::new(Line::from(header_spans))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER)),
        );
    f.render_widget(header, chunks[0]);

    // Plan content
    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(""));

    let block_title = if app.is_resume { " Resume " } else { " Plan " };

    if app.review_stories.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No stories in plan.",
            Style::default().fg(theme::MUTED),
        )));
    } else {
        for (i, story) in app.review_stories.iter().enumerate() {
            let is_selected = i == app.review_scroll;

            let marker = if app.is_resume {
                if story.completed {
                    "\u{2713}" // ✓
                } else {
                    "\u{25cb}" // ○
                }
            } else if is_selected {
                "\u{25b6}" // ▶
            } else {
                " "
            };

            let marker_style = if app.is_resume {
                if story.completed {
                    Style::default()
                        .fg(theme::SUCCESS)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(theme::MUTED)
                }
            } else if is_selected {
                Style::default()
                    .fg(theme::ACCENT)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::MUTED)
            };

            let title_style = if app.is_resume && story.completed {
                Style::default().fg(theme::SUCCESS)
            } else if is_selected {
                Style::default()
                    .fg(theme::TEXT)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::TEXT_DIM)
            };

            lines.push(Line::from(vec![
                Span::styled(format!(" {} ", marker), marker_style),
                Span::styled(
                    format!("{}: ", story.id),
                    Style::default()
                        .fg(theme::ACCENT)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(&story.title, title_style),
            ]));

            if !story.description.is_empty() {
                lines.push(Line::from(vec![
                    Span::raw("     "),
                    Span::styled(&story.description, Style::default().fg(theme::MUTED)),
                ]));
            }

            if !story.depends_on.is_empty() {
                lines.push(Line::from(vec![
                    Span::raw("     "),
                    Span::styled(
                        format!("\u{2514} deps: {}", story.depends_on.join(", ")),
                        Style::default().fg(theme::ACCENT_DIM),
                    ),
                ]));
            }

            lines.push(Line::from(""));
        }
    }

    let inner_height = chunks[1].height.saturating_sub(2) as usize;
    let total_lines = lines.len();

    let plan = Paragraph::new(lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    block_title,
                    Style::default()
                        .fg(theme::ACCENT)
                        .add_modifier(Modifier::BOLD),
                )),
        )
        .scroll((app.review_scroll_offset, 0))
        .wrap(Wrap { trim: false });
    f.render_widget(plan, chunks[1]);

    // Scrollbar
    if total_lines > inner_height {
        let mut scrollbar_state = ScrollbarState::new(total_lines.saturating_sub(inner_height))
            .position(app.review_scroll_offset as usize);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .style(Style::default().fg(theme::ACCENT_DIM))
            .begin_symbol(Some("\u{25b2}"))
            .end_symbol(Some("\u{25bc}"));
        f.render_stateful_widget(scrollbar, chunks[1], &mut scrollbar_state);
    }

    // Footer
    let accept_label = if app.is_resume {
        ":resume  "
    } else {
        ":accept  "
    };
    let footer = Paragraph::new(Line::from(vec![
        Span::styled(
            "Enter",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(accept_label, Style::default().fg(theme::MUTED)),
        Span::styled(
            "\u{2191}/\u{2193}",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(":scroll  ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "r",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(":refine  ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "q",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(":quit", Style::default().fg(theme::MUTED)),
    ]));
    f.render_widget(footer, chunks[2]);

    // Refine input overlay
    if let Some(ref input) = app.refine_input {
        let overlay_area = centered_rect(60, 5, area);

        f.render_widget(Clear, overlay_area);

        let cursor_char = if app.tick_count % 10 < 5 { "\u{2588}" } else { " " };
        let input_line = Line::from(vec![
            Span::styled(input.as_str(), Style::default().fg(theme::TEXT)),
            Span::styled(cursor_char, Style::default().fg(theme::ACCENT)),
        ]);
        let hint_line = Line::from(Span::styled(
            "Enter:send  Esc:cancel",
            Style::default().fg(theme::MUTED),
        ));

        let paragraph = Paragraph::new(vec![input_line, Line::from(""), hint_line])
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(theme::ACCENT))
                    .title(Span::styled(
                        " Refine Plan ",
                        Style::default()
                            .fg(theme::ACCENT)
                            .add_modifier(Modifier::BOLD),
                    )),
            )
            .wrap(Wrap { trim: false });
        f.render_widget(paragraph, overlay_area);
    } else if app.refining {
        let overlay_area = centered_rect(30, 3, area);

        f.render_widget(Clear, overlay_area);

        let paragraph = Paragraph::new(Line::from(Span::styled(
            "Refining...",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        )))
        .alignment(Alignment::Center)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::ACCENT)),
        );
        f.render_widget(paragraph, overlay_area);
    }
}

fn centered_rect(percent_x: u16, height: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length((area.height.saturating_sub(height)) / 2),
            Constraint::Length(height),
            Constraint::Min(0),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Min(0),
        ])
        .split(vertical[1])[1]
}
