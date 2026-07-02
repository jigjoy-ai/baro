use std::io::{self, Write};

/// Send a completion notification: terminal bell + OS-specific notification.
pub fn notify_completion() {
    print!("\x07");
    // OSC 777 notification (Ghostty)
    print!("\x1b]777;notify;baro;All stories complete\x1b\\");
    // iTerm2 notification
    print!("\x1b]1337;notify=All stories complete\x1b\\");
    // OSC 9 notification (supported by Ghostty, iTerm2, Windows Terminal)
    print!("\x1b]9;All stories complete\x1b\\");
    let _ = io::stdout().flush();

    match std::env::consts::OS {
        "macos" => {
            let _ = std::process::Command::new("osascript")
                .args(["-e", "display notification \"All stories complete\" with title \"baro\""])
                .spawn();
        }
        "linux" => {
            let _ = std::process::Command::new("notify-send")
                .args(["baro", "All stories complete"])
                .spawn();
        }
        "windows" => {
            let _ = std::process::Command::new("powershell")
                .args(["-Command", "[console]::beep(1000,500)"])
                .spawn();
        }
        _ => {}
    }
}

/// Clear the dock badge. Currently a no-op — badge clearing is handled
/// by the terminal itself when the user focuses the window.
pub fn clear_badge() {}
