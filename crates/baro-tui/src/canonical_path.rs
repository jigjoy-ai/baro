use std::io;
use std::path::{Path, PathBuf};

// Windows refuses the plain form past MAX_PATH; such paths keep the prefix.
const MAX_PLAIN_PATH_CHARS: usize = 247;

/// `std::fs::canonicalize` without Windows' verbatim prefix. The checkout path
/// is handed to Node helpers as `--cwd`, and Node 24's `realpathSync` fails on
/// `\\?\C:\…` with `EISDIR … lstat 'C:'` before any model is called (#202).
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    if !cfg!(windows) {
        return Ok(canonical);
    }
    Ok(match canonical.to_str().and_then(plain_windows_path) {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    })
}

/// `\\?\C:\dir` → `C:\dir`, `\\?\UNC\host\share` → `\\host\share`; `None` when
/// the path is not verbatim or has no equivalent plain form.
fn plain_windows_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    let plain = match rest.strip_prefix(r"UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => {
            let mut chars = rest.chars();
            let drive = chars.next()?;
            if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
                return None;
            }
            rest.to_string()
        }
    };
    // A component ending in a dot or space only exists in verbatim form.
    let fragile = plain
        .split('\\')
        .any(|part| part.ends_with('.') || part.ends_with(' '));
    (plain.chars().count() <= MAX_PLAIN_PATH_CHARS && !fragile).then_some(plain)
}

#[cfg(test)]
mod tests {
    use super::plain_windows_path;

    #[test]
    fn verbatim_drive_and_unc_paths_lose_the_prefix() {
        assert_eq!(
            plain_windows_path(r"\\?\C:\Users\dev\project").as_deref(),
            Some(r"C:\Users\dev\project"),
        );
        assert_eq!(
            plain_windows_path(r"\\?\UNC\host\share\repo").as_deref(),
            Some(r"\\host\share\repo"),
        );
    }

    #[test]
    fn paths_without_a_plain_form_are_left_alone() {
        assert_eq!(plain_windows_path(r"C:\Users\dev\project"), None);
        assert_eq!(plain_windows_path("/home/dev/project"), None);
        assert_eq!(plain_windows_path(r"\\?\Volume{1b3c}\repo"), None);
        assert_eq!(plain_windows_path(r"\\?\C:\repo\trailing. \x"), None);
        let long = format!(r"\\?\C:\{}", "a".repeat(260));
        assert_eq!(plain_windows_path(&long), None);
    }
}
