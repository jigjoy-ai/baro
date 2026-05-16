use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, LineGauge, Paragraph},
    Frame,
};

use crate::app::App;
use crate::theme;

const SPINNER_FRAMES: &[&str] = &[
    "\u{28cb}", "\u{28d9}", "\u{28f9}", "\u{28f8}", "\u{28fc}",
    "\u{28f4}", "\u{28e6}", "\u{28e7}", "\u{28c7}", "\u{28cf}",
];

pub fn render(f: &mut Frame, app: &App) {
    let area = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(2),
            Constraint::Length(7),   // Central box
            Constraint::Length(1),   // Spacer
            Constraint::Length(1),   // LineGauge
            Constraint::Length(1),   // Spacer
            Constraint::Length(1),   // Hint
            Constraint::Min(1),
        ])
        .split(area);

    let center = |area: Rect, width: u16| -> Rect {
        let pad = area.width.saturating_sub(width) / 2;
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(pad),
                Constraint::Length(width.min(area.width)),
                Constraint::Min(0),
            ])
            .split(area)[1]
    };

    let box_width = 50.min(area.width.saturating_sub(4));
    let box_area = center(chunks[1], box_width);

    let frame_idx = (app.tick_count / 2) as usize % SPINNER_FRAMES.len();
    let spinner = SPINNER_FRAMES[frame_idx];

    // See planning.rs: byte-index slicing panics on multi-byte chars
    // (em-dash, etc.). Truncate by char count instead.
    let goal_display = if app.goal_input.chars().count() > 42 {
        let truncated: String = app.goal_input.chars().take(39).collect();
        format!("{}...", truncated)
    } else {
        app.goal_input.clone()
    };

    // Pulse color on the spinner
    let spin_color = match (app.tick_count / 5) % 3 {
        0 => theme::LOGO_1,
        1 => theme::LOGO_2,
        _ => theme::LOGO_3,
    };

    let lines = vec![
        Line::from(""),
        Line::from(vec![
            Span::styled(
                format!(" {} ", spinner),
                Style::default().fg(spin_color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "Building context".to_string(),
                Style::default().fg(theme::TEXT).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::styled(" \u{2502} ", Style::default().fg(theme::BORDER)),
            Span::styled(&goal_display, Style::default().fg(theme::TEXT_DIM)),
        ]),
        Line::from(""),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::ACCENT_DIM))
        .title(Span::styled(
            " Context ",
            Style::default().fg(theme::ACCENT).add_modifier(Modifier::BOLD),
        ));

    let p = Paragraph::new(lines).block(block);
    f.render_widget(p, box_area);

    // Pulsing LineGauge (indeterminate progress)
    let gauge_width = 40.min(area.width.saturating_sub(4));
    let gauge_area = center(chunks[3], gauge_width);

    let cycle = (app.tick_count % 40) as f64 / 40.0;
    let ratio = (std::f64::consts::PI * 2.0 * cycle).sin().abs();

    let gauge_color = match (app.tick_count / 8) % 3 {
        0 => theme::LOGO_1,
        1 => theme::LOGO_2,
        _ => theme::LOGO_3,
    };

    let gauge = LineGauge::default()
        .label("")
        .ratio(ratio)
        .line_set(ratatui::symbols::line::THICK)
        .filled_style(Style::default().fg(gauge_color))
        .unfilled_style(Style::default().fg(theme::BORDER));
    f.render_widget(gauge, gauge_area);

    // Hint
    let hint = Paragraph::new(Line::from(vec![
        Span::styled("Scanning project structure...", Style::default().fg(theme::MUTED)),
    ]))
    .alignment(Alignment::Center);
    f.render_widget(hint, chunks[5]);
}
