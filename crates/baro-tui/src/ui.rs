use ratatui::Frame;

use crate::app::{App, Screen};
use crate::screens;

pub fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    match app.screen {
        Screen::ProviderPicker => screens::provider_picker::draw(f, app, area),
        Screen::ApiKeyInput => screens::api_key_input::draw(f, app, area),
        Screen::Welcome => screens::welcome::render(f, app),
        Screen::Context => screens::context::render(f, app),
        Screen::Planning => screens::planning::render(f, app),
        Screen::Review => screens::review::render(f, app),
        Screen::Execute => screens::execute::render(f, app),
    }
}
