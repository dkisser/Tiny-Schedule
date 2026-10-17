//! File reads and writes for a scheduled task.
//!
//! Two properties are worth more here than in the other two capabilities, and
//! both are about what happens when something goes wrong halfway:
//!
//!   - **Writes are atomic.** Content lands in a sibling temporary file and is
//!     then [`std::fs::rename`]d over the target, so a reader either sees the
//!     previous version or the new one — never a half-written file. This is the
//!     same tmp+rename rule the data store uses (ADR-0005), and the reason the
//!     temporary file is a *sibling* rather than in `$TMPDIR`: `rename` across
//!     filesystems fails, and a task writing to an external volume would lose
//!     every write to a `EXDEV` the agent has no way to interpret.
//!   - **Reads are bounded.** [`MAX_READ_BYTES`] caps what crosses the IPC
//!     boundary, and `offset`/`limit` let a model read a slice of a large file
//!     instead of the head of it.
//!
//! Paths are resolved against the task's execution directory by
//! [`resolve_path`](super::paths::resolve_path): an absolute path is taken as written, a `~`-prefixed one
//! expands against the home directory, and anything else is relative to the
//! task's `cwd`. Nothing restricts *which* path that is; per ADR-0008, an
//! unreadable or unwriteable path is simply reported as an error.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::paths::resolve_path;
use super::{to_text, GatewayContext, GatewayError, GatewayErrorCode};

/// Largest slice returned by one read, in bytes.
pub const MAX_READ_BYTES: usize = 1024 * 1024;

/// Read granularity while slicing a file.
const READ_CHUNK: usize = 16 * 1024;

/// A single `writeFile` call from the agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    /// Who is asking. Unused today, load-bearing the day permissions tighten.
    #[serde(flatten)]
    pub context: GatewayContext,
    pub path: String,
    /// The task's execution directory; a relative `path` is resolved against it.
    #[serde(default)]
    pub cwd: Option<String>,
    pub content: String,
}

/// A single `readFile` call from the agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileRequest {
    /// Who is asking. Unused today, load-bearing the day permissions tighten.
    #[serde(flatten)]
    pub context: GatewayContext,
    pub path: String,
    /// The task's execution directory; a relative `path` is resolved against it.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Byte offset to start at. `None` means the beginning of the file.
    #[serde(default)]
    pub offset: Option<u64>,
    /// Byte count to return. `None` means "whatever the cap allows".
    #[serde(default)]
    pub limit: Option<u64>,
}

/// What a write produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileOutcome {
    /// The path as the caller wrote it, echoed so the run record does not have
    /// to guess whether a relative path was resolved.
    pub path: String,
    pub bytes_written: usize,
}

/// What a read produced.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileOutcome {
    pub content: String,
    /// Size of the whole file, so a truncated slice is recognisable as one
    /// rather than mistaken for the entire file.
    pub total_bytes: u64,
    /// Bytes actually returned.
    pub returned_bytes: usize,
    /// The file is longer than what was returned, and more can be asked for.
    pub truncated: bool,
}

/// The gateway entry point for `writeFile`.
pub async fn write_file(request: WriteFileRequest) -> Result<WriteFileOutcome, GatewayError> {
    let target = resolve_path(&request.path, request.cwd.as_deref())?;

    let parent = target.parent().filter(|p| !p.as_os_str().is_empty());
    if let Some(parent) = parent {
        // A task writing `out/report.md` on its first run has no reason to know
        // that `out/` does not exist yet, and "No such file or directory" is a
        // worse answer than creating it.
        fs::create_dir_all(parent).map_err(|e| {
            GatewayError::new(
                GatewayErrorCode::Io,
                format!("cannot create {}: {e}", parent.display()),
            )
        })?;
    }

    let temp = temp_sibling(&target, &request.context.run_id);
    let written = write_atomically(&temp, &target, request.content.as_bytes());

    // Whatever went wrong, the partial file goes — leaving it behind would put a
    // plausible-looking artefact next to the target that no write ever
    // completed, which is exactly what a later reader would trust.
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }

    let bytes_written = written?;
    Ok(WriteFileOutcome {
        path: request.path,
        bytes_written,
    })
}

/// Writes `content` to `temp`, then moves it onto `target`.
///
/// Split out from [`write_file`] so the failure handling lives in one place: the
/// caller's cleanup runs on every error path without this function having to
/// duplicate it.
fn write_atomically(temp: &Path, target: &Path, content: &[u8]) -> Result<usize, GatewayError> {
    let mut file = File::create(temp).map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::Io,
            format!("cannot create {}: {e}", temp.display()),
        )
    })?;

    if let Err(e) = file.write_all(content).and_then(|()| file.sync_all()) {
        return Err(GatewayError::new(
            GatewayErrorCode::Io,
            format!("cannot write {}: {e}", temp.display()),
        ));
    }
    drop(file);

    fs::rename(temp, target).map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::Io,
            format!(
                "cannot move {} into place at {}: {e}",
                temp.display(),
                target.display()
            ),
        )
    })?;

    Ok(content.len())
}

/// The temporary file a write stages into.
///
/// A sibling of the target, named after the run so two concurrent runs cannot
/// stage into the same path. `run_id` comes from the caller, so it is reduced to
/// characters that are safe in a filename: a raw interpolation would let a run
/// id containing `../` aim the temporary file somewhere else entirely.
fn temp_sibling(target: &Path, run_id: &str) -> PathBuf {
    let safe: String = run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    let temp_name = if safe.is_empty() {
        format!(".{name}.tiny-schedule.tmp")
    } else {
        format!(".{name}.{safe}.tmp")
    };
    match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(temp_name),
        _ => PathBuf::from(temp_name),
    }
}

/// The gateway entry point for `readFile`.
pub async fn read_file(request: ReadFileRequest) -> Result<ReadFileOutcome, GatewayError> {
    let path = resolve_path(&request.path, request.cwd.as_deref())?;
    let span = read_span(request.offset, request.limit);
    read_slice(&path, span).await
}

/// The byte window a read will return, already clamped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    offset: u64,
    limit: u64,
}

fn read_span(offset: Option<u64>, limit: Option<u64>) -> Span {
    Span {
        offset: offset.unwrap_or(0),
        // `.min` against the cap is what makes the cap a floor no caller can go
        // under: a task asking for 10 MB gets 1 MB and a `truncated` flag.
        limit: limit
            .unwrap_or(MAX_READ_BYTES as u64)
            .min(MAX_READ_BYTES as u64),
    }
}

async fn read_slice(path: &Path, span: Span) -> Result<ReadFileOutcome, GatewayError> {
    let mut file = File::open(path).map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::Io,
            format!("cannot read {}: {e}", path.display()),
        )
    })?;

    // `metadata` on the open handle rather than on the path: this is a race-free
    // answer about the same inode the bytes come from, and it costs nothing
    // extra.
    let total_bytes = file
        .metadata()
        .map_err(|e| {
            GatewayError::new(
                GatewayErrorCode::Io,
                format!("cannot size {}: {e}", path.display()),
            )
        })?
        .len();

    // An offset past the end is not an error — it is an empty answer to an empty
    // question, and a model that asked for the tail of a short file should not
    // have to distinguish that from an I/O failure.
    if span.offset >= total_bytes {
        return Ok(ReadFileOutcome {
            content: String::new(),
            total_bytes,
            returned_bytes: 0,
            truncated: false,
        });
    }

    file.seek(SeekFrom::Start(span.offset)).map_err(|e| {
        GatewayError::new(
            GatewayErrorCode::Io,
            format!("cannot seek {}: {e}", path.display()),
        )
    })?;

    // `take` rather than `read_to_end`: the cap has to bound what is *read*, not
    // only what is returned, or a 4 GB log would be pulled into memory just to
    // have all but the first megabyte thrown away.
    let mut kept: Vec<u8> = Vec::with_capacity(span.limit.min(READ_CHUNK as u64) as usize);
    let mut chunk = vec![0u8; READ_CHUNK];
    let mut limited = (&mut file).take(span.limit);
    loop {
        match limited.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => kept.extend_from_slice(&chunk[..n]),
        }
    }

    let returned_bytes = kept.len();
    let end = span.offset.saturating_add(returned_bytes as u64);

    Ok(ReadFileOutcome {
        content: to_text(kept),
        total_bytes,
        returned_bytes,
        truncated: end < total_bytes,
    })
}

/// Tauri entry point for `writeFile`.
#[tauri::command]
pub async fn scheduled_write_file(
    request: WriteFileRequest,
) -> Result<WriteFileOutcome, GatewayError> {
    let context = request.context.clone();
    write_file(request)
        .await
        .map_err(|e| e.with_context(&context))
}

/// Tauri entry point for `readFile`.
#[tauri::command]
pub async fn scheduled_read_file(
    request: ReadFileRequest,
) -> Result<ReadFileOutcome, GatewayError> {
    let context = request.context.clone();
    read_file(request)
        .await
        .map_err(|e| e.with_context(&context))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_request(path: &Path, content: &str) -> WriteFileRequest {
        WriteFileRequest {
            context: GatewayContext {
                task_id: "t-1".to_string(),
                run_id: "run-9".to_string(),
            },
            path: path.to_string_lossy().into_owned(),
            cwd: None,
            content: content.to_string(),
        }
    }

    fn read_request(path: &Path, offset: Option<u64>, limit: Option<u64>) -> ReadFileRequest {
        ReadFileRequest {
            context: GatewayContext {
                task_id: "t-1".to_string(),
                run_id: "r-1".to_string(),
            },
            path: path.to_string_lossy().into_owned(),
            cwd: None,
            offset,
            limit,
        }
    }

    fn run() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tiny-schedule-gateway-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_write_lands_and_reads_back() {
        let dir = scratch("roundtrip");
        let path = dir.join("note.md");
        let rt = run();
        let outcome = rt
            .block_on(write_file(write_request(&path, "写周报")))
            .expect("write");
        assert_eq!(outcome.bytes_written, "写周报".len());
        assert_eq!(fs::read_to_string(&path).expect("read back"), "写周报");
    }

    #[test]
    fn a_write_replaces_a_previous_version_wholesale() {
        // The property tmp+rename buys: a shorter second write must not leave a
        // tail of the first one behind.
        let dir = scratch("replace");
        let path = dir.join("a.txt");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "a long first version")))
            .expect("first");
        rt.block_on(write_file(write_request(&path, "short")))
            .expect("second");
        assert_eq!(fs::read_to_string(&path).expect("read"), "short");
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let dir = scratch("no-temp");
        let path = dir.join("b.txt");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "x")))
            .expect("write");
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "staged files survived: {leftovers:?}");
    }

    #[test]
    fn a_failed_write_leaves_no_staged_file() {
        // Target is a directory, so the rename cannot succeed; the staging file
        // must not survive it, or a later reader finds a plausible artefact that
        // no write ever completed.
        let dir = scratch("failed");
        let path = dir.join("sub");
        fs::create_dir_all(&path).expect("dir");
        let error = run()
            .block_on(write_file(write_request(&path, "x")))
            .expect_err("writing over a directory must fail");
        assert_eq!(error.code, GatewayErrorCode::Io);
        let staged: Vec<_> = fs::read_dir(&dir)
            .expect("list")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(staged.is_empty(), "staged files survived the failure");
    }

    #[test]
    fn a_write_creates_missing_parent_directories() {
        let dir = scratch("parents");
        let path = dir.join("out/2026/report.md");
        run()
            .block_on(write_file(write_request(&path, "x")))
            .expect("write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "x");
    }

    #[test]
    fn the_staging_name_is_a_sibling_of_the_target() {
        // A `$TMPDIR` staging file would make `rename` fail with EXDEV on any
        // external volume, turning every write there into an error.
        let temp = temp_sibling(Path::new("/Volumes/data/out/report.md"), "run-9");
        assert_eq!(temp.parent(), Some(Path::new("/Volumes/data/out")));
        assert!(temp.to_string_lossy().ends_with(".tmp"));
    }

    #[test]
    fn a_traversing_run_id_cannot_redirect_the_staging_file() {
        // The run id comes from the caller, so it cannot be pasted into a path
        // unfiltered.
        let temp = temp_sibling(Path::new("/tmp/out/report.md"), "../../etc/evil");
        assert_eq!(temp.parent(), Some(Path::new("/tmp/out")));
        assert!(
            !temp.to_string_lossy().contains(".."),
            "run id leaked a traversal: {temp:?}"
        );
    }

    #[test]
    fn two_runs_stage_into_different_files() {
        let target = Path::new("/tmp/out/report.md");
        assert_ne!(temp_sibling(target, "run-1"), temp_sibling(target, "run-2"));
    }

    #[test]
    fn an_empty_path_is_refused() {
        let error = run()
            .block_on(write_file(write_request(Path::new("  "), "x")))
            .expect_err("an empty path must be refused");
        assert_eq!(error.code, GatewayErrorCode::InvalidRequest);
    }

    #[test]
    fn reading_a_missing_file_names_the_path() {
        let dir = scratch("missing");
        let error = run()
            .block_on(read_file(read_request(&dir.join("nope.txt"), None, None)))
            .expect_err("missing file must fail");
        assert_eq!(error.code, GatewayErrorCode::Io);
        assert!(error.message.contains("nope.txt"), "{}", error.message);
    }

    #[test]
    fn offset_and_limit_select_a_slice() {
        let dir = scratch("slice");
        let path = dir.join("lines.txt");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "0123456789")))
            .expect("write");
        let outcome = rt
            .block_on(read_file(read_request(&path, Some(3), Some(4))))
            .expect("read");
        assert_eq!(outcome.content, "3456");
        assert_eq!(outcome.returned_bytes, 4);
        assert_eq!(outcome.total_bytes, 10);
        assert!(outcome.truncated, "there is more after the slice");
    }

    #[test]
    fn a_read_of_the_whole_file_is_not_flagged_truncated() {
        // Off-by-one in the strict direction makes every complete read look
        // clipped, which pushes a model into re-reading the same file forever.
        let dir = scratch("whole");
        let path = dir.join("all.txt");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "hello")))
            .expect("write");
        let outcome = rt
            .block_on(read_file(read_request(&path, None, None)))
            .expect("read");
        assert_eq!(outcome.content, "hello");
        assert!(!outcome.truncated);
        assert_eq!(outcome.total_bytes, 5);
    }

    #[test]
    fn a_limit_beyond_the_end_is_not_flagged_truncated() {
        let dir = scratch("past-end");
        let path = dir.join("small.txt");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "abc")))
            .expect("write");
        let outcome = rt
            .block_on(read_file(read_request(&path, None, Some(1_000_000))))
            .expect("read");
        assert_eq!(outcome.content, "abc");
        assert!(!outcome.truncated);
    }

    #[test]
    fn an_offset_past_the_end_is_an_empty_answer_not_an_error() {
        // A model asking for the tail of a short file should not have to tell
        // that apart from an I/O failure.
        let dir = scratch("tail");
        let path = dir.join("short.txt");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "abc")))
            .expect("write");
        let outcome = rt
            .block_on(read_file(read_request(&path, Some(999), None)))
            .expect("read");
        assert_eq!(outcome.content, "");
        assert!(!outcome.truncated);
        assert_eq!(outcome.total_bytes, 3);
    }

    #[test]
    fn a_limit_over_the_cap_is_clamped_to_the_cap() {
        assert_eq!(
            read_span(None, Some(10 * 1024 * 1024)).limit,
            MAX_READ_BYTES as u64
        );
        assert_eq!(read_span(None, None).limit, MAX_READ_BYTES as u64);
        assert_eq!(read_span(Some(7), Some(5)).offset, 7);
    }

    #[test]
    fn multibyte_content_survives_the_round_trip() {
        // Byte slicing can land mid-character; the lossy conversion must degrade
        // rather than panic, and a whole-file read must be exact.
        let dir = scratch("cjk");
        let path = dir.join("写.md");
        let rt = run();
        rt.block_on(write_file(write_request(&path, "写周报写周报")))
            .expect("write");
        let outcome = rt
            .block_on(read_file(read_request(&path, None, None)))
            .expect("read");
        assert_eq!(outcome.content, "写周报写周报");
    }

    #[test]
    fn requests_deserialise_from_camel_case() {
        let read: ReadFileRequest = serde_json::from_str(
            r#"{"taskId":"t-1","runId":"r-1","path":"/tmp/x","offset":10,"limit":20}"#,
        )
        .expect("parse");
        assert_eq!(read.offset, Some(10));
        assert_eq!(read.limit, Some(20));

        let write: WriteFileRequest =
            serde_json::from_str(r#"{"taskId":"t-1","runId":"r-1","path":"/tmp/x","content":"c"}"#)
                .expect("parse");
        assert_eq!(write.content, "c");
    }
}
