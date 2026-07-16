use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::fs;
use uuid::Uuid;

const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

/// Cap for explorer fs.read / fs.write payloads (raw bytes, pre-base64).
#[cfg(test)]
pub const MAX_FS_BYTES: usize = 32 * 1024 * 1024;

/// Save raw bytes into `dir` under a sanitized `name`. When `overwrite` is
/// false a free `name-N.ext` variant is chosen instead of clobbering.
#[cfg(test)]
pub async fn save_file_in_dir(
    dir: &Path,
    name: &str,
    bytes: &[u8],
    overwrite: bool,
) -> Result<PathBuf> {
    if bytes.len() > MAX_FS_BYTES {
        anyhow::bail!("file exceeds 32 MB");
    }
    fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating directory {}", dir.display()))?;
    let file_name = sanitized_file_name(name, "", "file", false);
    let path = if overwrite {
        dir.join(&file_name)
    } else {
        available_upload_path(dir, &file_name).await?
    };
    fs::write(&path, bytes)
        .await
        .with_context(|| format!("writing file {}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
async fn save_image_upload(
    cwd: &str,
    name: &str,
    mime_type: &str,
    bytes_b64: &str,
) -> Result<PathBuf> {
    save_upload(cwd, name, mime_type, bytes_b64, false).await
}

pub async fn save_upload(
    cwd: &str,
    name: &str,
    mime_type: &str,
    bytes_b64: &str,
    save_to_cwd: bool,
) -> Result<PathBuf> {
    // Attachments accept images (terminal paste/drop) plus application/json
    // (the terminal refresh button's diagnostics bundles); mirrors the server
    // gate in agent_control.decode_upload.
    let is_attachment_type = mime_type.starts_with("image/") || mime_type == "application/json";
    if !save_to_cwd && !is_attachment_type {
        anyhow::bail!("upload is not an image");
    }
    if cwd.trim().is_empty() {
        anyhow::bail!("agent cwd is empty");
    }

    let bytes = STANDARD
        .decode(bytes_b64)
        .context("decoding image upload payload")?;
    if bytes.is_empty() {
        anyhow::bail!("image upload is empty");
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        anyhow::bail!("image upload exceeds 20 MB");
    }

    let cwd_path = Path::new(cwd);
    let dir = if save_to_cwd {
        cwd_path.to_path_buf()
    } else {
        cwd_path.join(".spawn").join("attachments")
    };
    fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("creating upload directory {}", dir.display()))?;

    let path = if save_to_cwd {
        available_upload_path(&dir, &sanitized_file_name(name, mime_type, "file", false)).await?
    } else {
        dir.join(unique_file_name(name, mime_type))
    };
    fs::write(&path, bytes)
        .await
        .with_context(|| format!("writing upload {}", path.display()))?;
    Ok(path)
}

pub fn paste_text_for_path(cwd: &str, path: &Path, prefix: Option<&str>) -> String {
    let token_path = path_for_prompt(cwd, path);
    let token_path = token_path.to_string_lossy();
    match prefix.unwrap_or_default() {
        "@" => format!("@{} ", token_path),
        _ => format!("{} ", shell_quote(&token_path)),
    }
}

fn path_for_prompt(cwd: &str, path: &Path) -> PathBuf {
    let cwd_path = Path::new(cwd);
    path.strip_prefix(cwd_path)
        .map(Path::to_path_buf)
        .unwrap_or_else(|_| path.to_path_buf())
}

fn unique_file_name(name: &str, mime_type: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let unique = Uuid::new_v4().simple().to_string();
    format!(
        "{stamp}-{}-{}",
        &unique[..8],
        sanitized_file_name(name, mime_type, "image", true)
    )
}

fn sanitized_file_name(
    name: &str,
    mime_type: &str,
    default_name: &str,
    add_image_extension: bool,
) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(default_name);
    let mut safe = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            safe.push(ch);
        } else {
            safe.push('_');
        }
        if safe.len() >= 96 {
            break;
        }
    }

    let safe = safe.trim_matches(['.', '_', '-']).to_string();
    let mut safe = if safe.is_empty() {
        default_name.to_string()
    } else {
        safe
    };
    if add_image_extension && Path::new(&safe).extension().is_none() {
        safe.push('.');
        safe.push_str(extension_for_mime(mime_type));
    }
    safe
}

async fn available_upload_path(dir: &Path, file_name: &str) -> Result<PathBuf> {
    let path = dir.join(file_name);
    if !fs::try_exists(&path)
        .await
        .with_context(|| format!("checking upload path {}", path.display()))?
    {
        return Ok(path);
    }

    let file_path = Path::new(file_name);
    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("file");
    let extension = file_path.extension().and_then(|s| s.to_str());
    for n in 2..10_000 {
        let candidate_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem}-{n}.{ext}"),
            _ => format!("{stem}-{n}"),
        };
        let candidate = dir.join(candidate_name);
        if !fs::try_exists(&candidate)
            .await
            .with_context(|| format!("checking upload path {}", candidate.display()))?
        {
            return Ok(candidate);
        }
    }

    anyhow::bail!("could not choose a free upload filename for {}", file_name)
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-' | b':'))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn save_file_in_dir_respects_overwrite_flag() {
        let dir = std::env::temp_dir().join(format!("spawn-fs-test-{}", Uuid::new_v4().simple()));

        let first = save_file_in_dir(&dir, "../notes 1.txt", b"one", false)
            .await
            .unwrap();
        assert_eq!(first, dir.join("notes_1.txt"));

        let second = save_file_in_dir(&dir, "notes 1.txt", b"two", false)
            .await
            .unwrap();
        assert_eq!(second, dir.join("notes_1-2.txt"));

        let third = save_file_in_dir(&dir, "notes 1.txt", b"three", true)
            .await
            .unwrap();
        assert_eq!(third, first);
        assert_eq!(fs::read(&first).await.unwrap(), b"three");

        fs::remove_dir_all(&dir).await.unwrap();
    }

    #[test]
    fn sanitizes_upload_names() {
        let name = sanitized_file_name("../Screen Shot 1.png", "image/png", "image", true);
        assert_eq!(name, "Screen_Shot_1.png");

        let name = sanitized_file_name("", "image/jpeg", "image", true);
        assert_eq!(name, "image.jpg");

        let name = sanitized_file_name("../notes 1.txt", "text/plain", "file", false);
        assert_eq!(name, "notes_1.txt");
    }

    #[test]
    fn quotes_paths_for_terminal_paste() {
        assert_eq!(
            paste_text_for_path("", Path::new("/tmp/spawn image's.png"), None),
            "'/tmp/spawn image'\\''s.png' "
        );
        assert_eq!(
            paste_text_for_path("", Path::new("/tmp/spawn-image.png"), None),
            "/tmp/spawn-image.png "
        );
        assert_eq!(
            paste_text_for_path(
                "/repo",
                Path::new("/repo/.spawn/attachments/shot.png"),
                Some("@")
            ),
            "@.spawn/attachments/shot.png "
        );
    }

    #[tokio::test]
    async fn saves_image_upload_under_agent_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let data = STANDARD.encode(b"png-ish");
        let path = save_image_upload(tmp.path().to_str().unwrap(), "shot.png", "image/png", &data)
            .await
            .unwrap();
        assert!(path.starts_with(tmp.path().join(".spawn").join("attachments")));
        assert_eq!(std::fs::read(path).unwrap(), b"png-ish");
    }

    #[tokio::test]
    async fn saves_cwd_upload_without_overwriting_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("note.txt"), b"old").unwrap();
        let data = STANDARD.encode(b"new");
        let path = save_upload(
            tmp.path().to_str().unwrap(),
            "../note.txt",
            "text/plain",
            &data,
            true,
        )
        .await
        .unwrap();

        assert_eq!(path, tmp.path().join("note-2.txt"));
        assert_eq!(std::fs::read(tmp.path().join("note.txt")).unwrap(), b"old");
        assert_eq!(std::fs::read(path).unwrap(), b"new");
    }

    #[tokio::test]
    async fn rejects_non_image_uploads() {
        let tmp = tempfile::tempdir().unwrap();
        let data = STANDARD.encode(b"text");
        let err = save_image_upload(
            tmp.path().to_str().unwrap(),
            "note.txt",
            "text/plain",
            &data,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("not an image"));
    }
}
