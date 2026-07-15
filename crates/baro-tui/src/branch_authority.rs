//! Safety policy for reusing an existing branch across conversation runs.
//!
//! `--continue` is allowed to update an established Baro PR branch; it must
//! never turn an intake/planning retry into commits on the repository's
//! default branch merely because that happens to be the current checkout.

const PROTECTED_BRANCHES: [&str; 5] = ["main", "master", "trunk", "develop", "development"];

pub(crate) fn verify_continuation_branch(
    current: &str,
    prd_branch_hint: Option<&str>,
) -> Result<String, String> {
    let current = current.trim();
    if current.is_empty() || current == "HEAD" {
        return Err("--continue requires a named branch checkout".to_string());
    }
    if PROTECTED_BRANCHES
        .iter()
        .any(|protected| current.eq_ignore_ascii_case(protected))
    {
        return Err(format!(
            "refusing --continue on protected branch '{current}'; check out the existing Baro PR branch first"
        ));
    }

    if let Some(hint) = prd_branch_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        let normalized = if hint.starts_with("baro/") {
            hint.to_string()
        } else {
            format!("baro/{hint}")
        };
        if current != normalized {
            return Err(format!(
                "--continue branch mismatch: current branch is '{current}', but prd.json owns '{normalized}'"
            ));
        }
        return Ok(current.to_string());
    }

    if !current.starts_with("baro/") {
        return Err(format!(
            "refusing --continue on unverified branch '{current}'; no matching Baro branch checkpoint was found"
        ));
    }
    Ok(current.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_requires_an_established_baro_branch() {
        assert_eq!(
            verify_continuation_branch("baro/auth-2", Some("baro/auth-2")).unwrap(),
            "baro/auth-2"
        );
        assert_eq!(
            verify_continuation_branch("baro/auth", Some("auth")).unwrap(),
            "baro/auth"
        );
        assert_eq!(
            verify_continuation_branch("baro/auth", None).unwrap(),
            "baro/auth"
        );
    }

    #[test]
    fn continuation_rejects_protected_detached_and_mismatched_checkouts() {
        for branch in ["main", "MASTER", "trunk", "HEAD", ""] {
            assert!(verify_continuation_branch(branch, None).is_err());
        }
        assert!(verify_continuation_branch("feature/manual", None).is_err());
        assert!(verify_continuation_branch("baro/other", Some("baro/auth")).is_err());
    }
}
