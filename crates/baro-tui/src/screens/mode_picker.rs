//! Execution-mode picker — shown between the Architect and Planner
//! when `--mode auto` (the default) runs interactively. The intake's
//! proposal is preselected; Enter confirms, picking a different row
//! overrides the contract.

use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{App, MODE_OPTIONS};
use crate::theme;

fn mode_title(mode: &str) -> &'static str {
    match mode {
        "sequential" => "Sequential",
        "parallel" => "Parallel",
        _ => "Focused",
    }
}

fn mode_description(mode: &str) -> &'static str {
    match mode {
        "sequential" => "A few ordered stories, one agent at a time — for stepwise work on shared code.",
        "parallel" => "Full DAG fan-out — several agents on independent write surfaces at once.",
        _ => "One story, one strong agent — for bugfixes and single-surface changes.",
    }
}

pub fn draw(f: &mut Frame, app: &App, area: Rect) {
    let num_options = MODE_OPTIONS.len();

    let mut constraints: Vec<Constraint> = vec![
        Constraint::Length(2), // top padding
        Constraint::Length(2), // title
        Constraint::Length(2), // subtitle
        Constraint::Length(2), // suggestion
        Constraint::Length(1), // gap
    ];
    for i in 0..num_options {
        constraints.push(Constraint::Length(5)); // option box
        if i < num_options - 1 {
            constraints.push(Constraint::Length(1)); // gap between options
        }
    }
    constraints.push(Constraint::Length(2)); // gap before hint
    constraints.push(Constraint::Length(2)); // hint
    constraints.push(Constraint::Min(0)); // remaining

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(centred(area, 78));

    let title = Paragraph::new(Line::from(vec![Span::styled(
        "baro",
        Style::default()
            .fg(theme::LOGO_2)
            .add_modifier(Modifier::BOLD),
    )]))
    .alignment(Alignment::Center);
    f.render_widget(title, chunks[1]);

    let subtitle = Paragraph::new(Line::from(vec![Span::styled(
        "Pick an execution mode",
        Style::default().fg(theme::TEXT),
    )]))
    .alignment(Alignment::Center);
    f.render_widget(subtitle, chunks[2]);

    if let Some(ref p) = app.mode_proposal {
        let suggestion = Paragraph::new(Line::from(vec![
            Span::styled("Baro suggests: ", Style::default().fg(theme::MUTED)),
            Span::styled(
                mode_title(&p.mode),
                Style::default()
                    .fg(theme::ACCENT_BRIGHT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(" ({:.0}% confident)", p.confidence * 100.0),
                Style::default().fg(theme::MUTED),
            ),
            Span::styled(format!(" — {}", p.reason), Style::default().fg(theme::TEXT_DIM)),
        ]))
        .alignment(Alignment::Center)
        .wrap(Wrap { trim: true });
        f.render_widget(suggestion, chunks[3]);
    }

    let options_start = 5; // chunk index where option boxes begin
    for (i, mode) in MODE_OPTIONS.iter().enumerate() {
        let selected = app.mode_picker_index == i;
        let suggested = app
            .mode_proposal
            .as_ref()
            .map(|p| p.mode == *mode)
            .unwrap_or(false);
        let chunk_idx = options_start + i * 2;
        if chunk_idx < chunks.len() {
            f.render_widget(
                option_widget(selected, suggested, mode_title(mode), mode_description(mode)),
                chunks[chunk_idx],
            );
        }
    }

    let hint_idx = chunks.len() - 2;
    let hint = Paragraph::new(Line::from(vec![
        Span::styled(
            "↑",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("/", Style::default().fg(theme::MUTED)),
        Span::styled(
            "↓",
            Style::default()
                .fg(theme::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  choose    ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "Enter",
            Style::default()
                .fg(theme::SUCCESS)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  confirm    ", Style::default().fg(theme::MUTED)),
        Span::styled(
            "q",
            Style::default()
                .fg(theme::ERROR)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("  quit", Style::default().fg(theme::MUTED)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(hint, chunks[hint_idx]);
}

fn option_widget(selected: bool, suggested: bool, title: &str, body: &str) -> Paragraph<'static> {
    let (border, title_style, marker) = if selected {
        (
            theme::ACCENT,
            Style::default()
                .fg(theme::ACCENT_BRIGHT)
                .add_modifier(Modifier::BOLD),
            "▶  ",
        )
    } else {
        (
            theme::BORDER,
            Style::default().fg(theme::TEXT_DIM),
            "   ",
        )
    };

    let mut title_spans = vec![
        Span::styled(marker.to_string(), Style::default().fg(theme::ACCENT)),
        Span::styled(title.to_string(), title_style),
    ];
    if suggested {
        title_spans.push(Span::styled(
            "  (suggested)",
            Style::default().fg(theme::SUCCESS),
        ));
    }

    let lines: Vec<Line<'static>> = vec![
        Line::from(""),
        Line::from(title_spans),
        Line::from(vec![
            Span::raw("   "),
            Span::styled(body.to_string(), Style::default().fg(theme::MUTED)),
        ]),
    ];

    Paragraph::new(lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(border)),
        )
        .wrap(Wrap { trim: false })
}

fn centred(area: Rect, width: u16) -> Rect {
    if area.width <= width {
        return area;
    }
    let pad = (area.width - width) / 2;
    Rect {
        x: area.x + pad,
        y: area.y,
        width,
        height: area.height,
    }
}
