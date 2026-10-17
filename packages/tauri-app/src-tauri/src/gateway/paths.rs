//! Path resolution for the capability gateway.
//!
//! Three capabilities take a path from the renderer — `exec`'s working
//! directory, and `writeFile` / `readFile`'s target — and all three have to
//! answer the same question first: relative to *what*? The answer is the task's
//! execution directory, which lives on the request rather than in any global,
//! so the resolution has to take it as an argument.
//!
//! Split out of `exec.rs` because it is not about spawning processes: `files.rs`
//! depends on it too, and a shared helper buried in the middle of a command's
//! implementation reads like an implementation detail of that command.

use std::path::{Path, PathBuf};

use super::{GatewayError, GatewayErrorCode};

/// The user's home directory, or `None` when the process cannot determine it.
///
/// Delegates to [`crate::host::home_dir`] rather than reading the environment
/// again: the data directory already needs this answer, and two copies of "where
/// is home" drift apart the moment one of them is fixed — this one already
/// gained a `USERPROFILE` fallback the other did not.
pub fn home_dir() -> Option<PathBuf> {
    crate::host::home_dir().ok().map(PathBuf::from)
}

/// Expands a leading `~` to the user's home directory.
///
/// Only the two forms a shell would also expand: `~` and `~/…`. A `~` that is
/// not the entire first segment (`~backup`) is an ordinary relative name, and
/// is left alone — matching what a user typing into the dialog expects, and
/// avoiding the surprise of a directory the shell would have treated literally.
///
/// Both separators are accepted after the tilde: a Windows path typed by a user
/// into the dialog is `~\projects\x`, and expanding only the forward slash would
/// leave it literal on the platform that uses it.
///
/// Unresolvable (`HOME` unset, as under some launch daemons) falls back to the
/// input unchanged, so the caller's `is_dir()` check produces the ordinary
/// "not a directory" error naming the path rather than a tilde-specific one.
pub(super) fn expand_home(raw: &str) -> PathBuf {
    let rest = match raw.strip_prefix('~') {
        Some("") => Path::new(""),
        Some(after_tilde) => match after_tilde.strip_prefix('/') {
            Some(tail) => Path::new(tail),
            None => match after_tilde.strip_prefix('\\') {
                Some(tail) => Path::new(tail),
                // `~user` is another user's home, which this does not resolve.
                None => return PathBuf::from(raw),
            },
        },
        None => return PathBuf::from(raw),
    };
    match home_dir() {
        // Joining an empty path would append a separator (`/home/x/`), which is
        // the same directory but prints with a trailing slash in every error
        // message and audit record that names the cwd.
        Some(home) if rest.as_os_str().is_empty() => home,
        Some(home) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

/// Resolves and sanity-checks the working directory.
///
/// A missing directory surfaces as an ordinary spawn failure otherwise, and
/// "No such file or directory (os error 2)" names neither the path nor which of
/// the two (the directory, or the program) was missing.
pub(crate) fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, GatewayError> {
    let Some(raw) = cwd.map(str::trim).filter(|c| !c.is_empty()) else {
        return std::env::current_dir()
            .map_err(|e| GatewayError::new(GatewayErrorCode::Io, format!("cannot read cwd: {e}")));
    };
    let path = expand_home(raw);
    if !path.is_dir() {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            format!("cwd is not a directory: {raw}"),
        ));
    }
    Ok(path)
}

/// Resolves a path a caller sent, against the task's working directory.
///
/// The three cases the TS layer's own doc promises, in one place:
///   - an absolute path is already decided, and is used as it stands;
///   - a `~`-prefixed path expands against the home directory;
///   - anything else is relative to the task's execution directory.
///
/// Without this, a relative path lands wherever the OS happens to have started
/// the app from, and the "execution directory" in the tool description is a
/// claim rather than a fact.
pub(crate) fn resolve_path(raw: &str, cwd: Option<&str>) -> Result<PathBuf, GatewayError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GatewayError::new(
            GatewayErrorCode::InvalidRequest,
            "path must not be empty",
        ));
    }
    let as_path = Path::new(trimmed);
    if as_path.is_absolute() {
        return Ok(as_path.to_path_buf());
    }
    if trimmed.starts_with('~') {
        return Ok(expand_home(trimmed));
    }
    let base = resolve_cwd(cwd)?;
    Ok(base.join(as_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tilde_cwd_resolves_to_the_home_directory() {
        // The renderer sends `~` for "no working directory set", and a task
        // author may type `~/projects/x` by hand. A literal `~` is a relative
        // path, so `is_dir()` rejects it and every shell call in every such task
        // fails — the default must mean "the user's home", not "a directory
        // named ~".
        let Some(home) = home_dir() else {
            // No home to expand against; the fallback is covered separately.
            return;
        };
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/"), home);
        assert_eq!(expand_home("~/projects/x"), home.join("projects/x"));
        // A `~` that is not the whole first segment is an ordinary name.
        assert_eq!(expand_home("~backup"), PathBuf::from("~backup"));
        assert_eq!(expand_home("/abs/~/x"), PathBuf::from("/abs/~/x"));
    }

    #[test]
    fn a_bare_tilde_does_not_gain_a_trailing_separator() {
        // Every error message and audit record names the cwd; `/home/x/` is the
        // same directory, and printing it that way reads as a different path.
        let Some(home) = home_dir() else { return };
        assert_eq!(expand_home("~").to_string_lossy(), home.to_string_lossy());
    }

    #[test]
    fn a_relative_path_resolves_against_the_task_directory() {
        let dir = std::env::temp_dir().join("tiny-schedule-gateway-resolve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");

        let resolved = resolve_path("out/report.md", Some(dir.to_string_lossy().as_ref()))
            .expect("a relative path resolves against the task's directory");
        assert!(
            resolved.ends_with("out/report.md"),
            "expected the relative path joined onto the task directory, got {}",
            resolved.display()
        );
        // Compared against the un-canonicalized scratch dir: `resolve_path` does
        // not resolve symlinks, and canonicalizing one side would test that.
        assert_eq!(resolved.parent().unwrap().parent().unwrap(), dir);
    }

    #[test]
    fn an_absolute_path_is_left_exactly_as_written() {
        let abs = PathBuf::from("/tmp").join("tiny-schedule-abs");
        assert_eq!(
            resolve_path(&abs.to_string_lossy(), Some("/nowhere/at/all")).expect("absolute"),
            abs
        );
    }

    #[test]
    fn an_empty_path_is_refused_before_it_is_resolved() {
        let error = resolve_path("   ", Some("~")).expect_err("blank path must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
    }
}
