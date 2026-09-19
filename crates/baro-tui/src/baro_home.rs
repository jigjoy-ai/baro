use std::ffi::OsString;
use std::path::PathBuf;

pub fn baro_home() -> PathBuf {
    resolve(
        std::env::var_os("BARO_HOME"),
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
    )
}

fn resolve(
    baro_home: Option<OsString>,
    home: Option<OsString>,
    user_profile: Option<OsString>,
) -> PathBuf {
    let non_empty = |value: Option<OsString>| value.filter(|v| !v.is_empty());
    if let Some(dir) = non_empty(baro_home) {
        return PathBuf::from(dir);
    }
    non_empty(home)
        .or_else(|| non_empty(user_profile))
        .map(|dir| PathBuf::from(dir).join(".baro"))
        .unwrap_or_else(|| PathBuf::from(".baro"))
}

#[cfg(test)]
mod tests {
    use super::resolve;
    use std::path::PathBuf;

    #[test]
    fn baro_home_prefers_override_then_home_then_user_profile() {
        let some = |s: &str| Some(s.into());
        assert_eq!(resolve(some("/x"), some("/h"), None), PathBuf::from("/x"));
        assert_eq!(
            resolve(some(""), some("/h"), None),
            PathBuf::from("/h/.baro")
        );
        assert_eq!(resolve(None, None, some("/u")), PathBuf::from("/u/.baro"));
    }
}
