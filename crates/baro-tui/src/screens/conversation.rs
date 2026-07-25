use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::App;
use crate::conversation::{ConversationPhase, TranscriptRole};
use crate::theme;

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(5),
            Constraint::Length(2),
        ])
        .split(area);

    let phase = phase_label(app.conversation.phase());
    let header = Paragraph::new(Line::from(vec![
        Span::styled(
            " BARO ",
            Style::default()
                .fg(theme::ACCENT_BRIGHT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled("conversation", Style::default().fg(theme::TEXT)),
        Span::styled("  ·  ", Style::default().fg(theme::MUTED)),
        Span::styled(phase, Style::default().fg(theme::ACCENT)),
    ]))
    .block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(theme::BORDER)),
    );
    frame.render_widget(header, chunks[0]);

    let mut lines = Vec::new();
    if app.conversation.transcript().is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled(
                "Baro  ",
                Style::default()
                    .fg(theme::ACCENT_BRIGHT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "What do you want to build or change?",
                Style::default().fg(theme::TEXT),
            ),
        ]));
        lines.push(Line::from(Span::styled(
            "      I will ask only questions that materially affect scope, safety, or acceptance.",
            Style::default().fg(theme::TEXT_DIM),
        )));
    } else {
        for turn in app.conversation.transcript() {
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
                TranscriptRole::System => ("System", Style::default().fg(theme::MUTED)),
            };
            for (index, text) in turn.text.lines().enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(
                        if index == 0 {
                            format!("{label:<6}")
                        } else {
                            "      ".to_string()
                        },
                        style,
                    ),
                    Span::styled(text.to_string(), Style::default().fg(theme::TEXT)),
                ]));
            }
            lines.push(Line::from(""));
        }
    }
    let visible = chunks[1].height.saturating_sub(2) as usize;
    let start = lines.len().saturating_sub(visible);
    let transcript = Paragraph::new(lines.into_iter().skip(start).collect::<Vec<_>>())
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(theme::BORDER))
                .title(Span::styled(
                    " Session ",
                    Style::default().fg(theme::TEXT_DIM),
                )),
        );
    frame.render_widget(transcript, chunks[1]);

    let input_text = if app.conversation_busy {
        let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        format!(
            " {} Understanding your request…",
            frames[(app.tick_count as usize / 2) % frames.len()]
        )
    } else if app.conversation_input.is_empty() {
        " Type a goal, answer, or follow-up…".to_string()
    } else {
        format!(" {}█", app.conversation_input)
    };
    let input_border = if app.conversation_error.is_some() {
        theme::ERROR
    } else if app.conversation_busy {
        theme::ACCENT_DIM
    } else {
        theme::BORDER_ACTIVE
    };
    let input = Paragraph::new(input_text).wrap(Wrap { trim: false }).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(input_border))
            .title(Span::styled(" Message ", Style::default().fg(theme::TEXT))),
    );
    frame.render_widget(input, chunks[2]);

    let footer = if let Some(error) = &app.conversation_error {
        Line::from(vec![
            Span::styled(" error: ", Style::default().fg(theme::ERROR)),
            Span::styled(
                truncate(error, area.width.saturating_sub(10) as usize),
                Style::default().fg(theme::TEXT_DIM),
            ),
        ])
    } else {
        Line::from(vec![
            Span::styled(" Enter", Style::default().fg(theme::SUCCESS)),
            Span::styled(" send  ·  ", Style::default().fg(theme::MUTED)),
            Span::styled("Ctrl+U", Style::default().fg(theme::ACCENT)),
            Span::styled(
                " clear  ·  Esc quit  ·  backend: ",
                Style::default().fg(theme::MUTED),
            ),
            Span::styled(app.llm.as_str(), Style::default().fg(theme::ACCENT)),
        ])
    };
    frame.render_widget(Paragraph::new(footer), chunks[3]);
}

fn phase_label(phase: ConversationPhase) -> &'static str {
    match phase {
        ConversationPhase::Clarifying => "understanding goal",
        ConversationPhase::NeedsInput => "needs input",
        ConversationPhase::Ready => "goal ready",
        ConversationPhase::Planning => "planning",
        ConversationPhase::Executing => "executing",
        ConversationPhase::Verifying => "verifying",
        ConversationPhase::Completed => "ready for follow-up",
        ConversationPhase::Failed => "run failed · ready for follow-up",
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        value
            .chars()
            .take(max.saturating_sub(1))
            .collect::<String>()
            + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn conversation_screen_renders_at_small_sizes() {
        for (width, height) in [(40, 12), (80, 24), (140, 40)] {
            let mut app = App::new();
            app.start_conversation();
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            terminal.draw(|frame| render(frame, &app)).unwrap();
        }
    }
}
