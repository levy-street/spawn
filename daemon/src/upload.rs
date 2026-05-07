use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use tokio::fs;
use uuid::Uuid;

const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

pub async fn save_image_upload(
    cwd: &str,
    name: &str,
    mime_type: &str,
    bytes_b64: &str,
) -> Result<PathBuf> {
    if !mime_type.starts_with("image/") {
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
    let dir = cwd_path.join(".spawn").join("attachments");
    fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("creating attachment directory {}", dir.display()))?;

    let file_name = unique_file_name(name, mime_type);
    let path = dir.join(file_name);
    fs::write(&path, bytes)
        .await
        .with_context(|| format!("writing attachment {}", path.display()))?;
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
        sanitized_file_name(name, mime_type)
    )
}

fn sanitized_file_name(name: &str, mime_type: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image");
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
        "image".to_string()
    } else {
        safe
    };
    if Path::new(&safe).extension().is_none() {
        safe.push('.');
        safe.push_str(extension_for_mime(mime_type));
    }
    safe
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

    #[test]
    fn sanitizes_upload_names() {
        let name = sanitized_file_name("../Screen Shot 1.png", "image/png");
        assert_eq!(name, "Screen_Shot_1.png");

        let name = sanitized_file_name("", "image/jpeg");
        assert_eq!(name, "image.jpg");
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
