//! Content classification for host files.
//!
//! Two signals, and magic always wins: a name is a claim, bytes are evidence.
//! That ordering is what makes `open_allowed` safe to act on — a Mach-O binary
//! named `notes.txt` must never be handed to LaunchServices because its
//! extension looked harmless.
//!
//! Deliberately hand-written rather than pulled from a crate. The table is
//! about forty lines, it carries a `preview` column no general-purpose MIME
//! crate provides, and `daemon/src/sessiond/foreground.rs` already sets the
//! precedent of writing the small thing instead of taking the dependency.
//!
//! Pure: no I/O, no allocation beyond a lowercased extension, exhaustively
//! table-testable.

use std::ffi::OsStr;
use std::path::Path;

/// How a preview for this file should be produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreviewKind {
    /// The browser can render the bytes itself.
    Native,
    /// Only the host can render it, via QuickLook.
    Quicklook,
    /// Nothing to render; show metadata.
    Metadata,
}

impl PreviewKind {
    pub(crate) fn as_wire(self) -> &'static str {
        match self {
            PreviewKind::Native => "native",
            PreviewKind::Quicklook => "quicklook",
            PreviewKind::Metadata => "metadata",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Classification {
    pub content_type: &'static str,
    /// `"magic"`, `"extension"` or `"unknown"` — how `content_type` was decided.
    pub source: &'static str,
    pub preview: PreviewKind,
    /// Whether the daemon is willing to hand this file to the desktop.
    pub open_allowed: bool,
}

/// Bytes inspected when sniffing. The caller reads at least this many.
pub(crate) const SNIFF_BYTES: usize = 4096;

const OCTET: &str = "application/octet-stream";

/// Extensions that must never be opened, whatever their bytes look like.
///
/// The URL-indirection formats are the interesting half: `.webloc` and friends
/// are tiny plists that sniff as perfectly ordinary text, and handing one to
/// LaunchServices hands an arbitrary scheme to the OS. A denylist alone would
/// be hopeless on macOS — any installed app can claim any extension — but as a
/// second gate behind the allowlist it closes the one hole the allowlist has.
const NEVER_OPEN: &[&str] = &[
    "webloc",
    "inetloc",
    "fileloc",
    "url",
    "desktop",
    "lnk",
    "scf",
    "command",
    "app",
    "workflow",
    "scpt",
    "scptd",
    "applescript",
    "action",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ksh",
    "csh",
    "ps1",
    "bat",
    "cmd",
    "com",
    "exe",
    "msi",
    "pkg",
    "mpkg",
    "dmg",
    "jar",
    "apk",
    "appex",
    "kext",
    "prefpane",
    "qlgenerator",
    "saver",
    "service",
    "wflow",
    "terminal",
    "vbs",
    "js",
];

/// ZIP-container formats we are willing to open, keyed by extension.
///
/// Every one of these sniffs as `PK\x03\x04`, so the extension is the only
/// thing separating a Word document from a `.jar`. Anything not listed keeps
/// the generic zip type and stays unopenable.
const ZIP_DOCUMENTS: &[(&str, &str)] = &[
    (
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    (
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    (
        "pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    ("odt", "application/vnd.oasis.opendocument.text"),
    ("ods", "application/vnd.oasis.opendocument.spreadsheet"),
    ("odp", "application/vnd.oasis.opendocument.presentation"),
    ("key", "application/x-iwork-keynote-sffkey"),
    ("pages", "application/x-iwork-pages-sffpages"),
    ("numbers", "application/x-iwork-numbers-sffnumbers"),
    ("epub", "application/epub+zip"),
];

/// Content types the daemon will hand to the desktop.
///
/// An allowlist, never a denylist: macOS UTIs are extensible and any installed
/// application can claim a type, so enumerating what is safe is the only
/// direction that stays correct as software is installed.
fn type_is_openable(content_type: &str) -> bool {
    if content_type.starts_with("image/")
        || content_type.starts_with("audio/")
        || content_type.starts_with("video/")
    {
        return true;
    }
    matches!(
        content_type,
        "application/pdf"
            | "text/plain"
            | "text/csv"
            | "text/markdown"
            | "text/html"
            | "application/rtf"
            | "application/json"
            | "application/xml"
    ) || ZIP_DOCUMENTS.iter().any(|(_, mime)| *mime == content_type)
}

/// Formats that are code the machine can run. Never previewed, never opened.
fn is_executable_magic(head: &[u8]) -> bool {
    const MACH_O: [&[u8]; 6] = [
        &[0xFE, 0xED, 0xFA, 0xCE],
        &[0xFE, 0xED, 0xFA, 0xCF],
        &[0xCE, 0xFA, 0xED, 0xFE],
        &[0xCF, 0xFA, 0xED, 0xFE],
        // Universal ("fat") binaries, both byte orders. `CAFEBABE` is also a
        // Java class file, which is equally not something to launch.
        &[0xCA, 0xFE, 0xBA, 0xBE],
        &[0xBE, 0xBA, 0xFE, 0xCA],
    ];
    if MACH_O.iter().any(|magic| head.starts_with(magic)) {
        return true;
    }
    head.starts_with(b"\x7FELF") || head.starts_with(b"MZ") || head.starts_with(b"#!")
}

/// Content type from the leading bytes, for formats with an unambiguous magic.
fn sniff_magic(head: &[u8]) -> Option<&'static str> {
    let checks: &[(&[u8], &str)] = &[
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"\xFF\xD8\xFF", "image/jpeg"),
        (b"GIF87a", "image/gif"),
        (b"GIF89a", "image/gif"),
        (b"BM", "image/bmp"),
        (b"II*\x00", "image/tiff"),
        (b"MM\x00*", "image/tiff"),
        (b"\x00\x00\x01\x00", "image/x-icon"),
        (b"%PDF-", "application/pdf"),
        (b"OggS", "audio/ogg"),
        (b"fLaC", "audio/flac"),
        (b"ID3", "audio/mpeg"),
        (b"\x1A\x45\xDF\xA3", "video/x-matroska"),
        (b"\x1F\x8B", "application/gzip"),
        (b"7z\xBC\xAF\x27\x1C", "application/x-7z-compressed"),
        (b"Rar!", "application/vnd.rar"),
        (b"\xFD7zXZ\x00", "application/x-xz"),
        (b"\x28\xB5\x2F\xFD", "application/zstd"),
        (b"{\\rtf", "application/rtf"),
        (b"SQLite format 3\x00", "application/vnd.sqlite3"),
        (b"wOFF", "font/woff"),
        (b"wOF2", "font/woff2"),
    ];
    for (magic, mime) in checks {
        if head.starts_with(magic) {
            return Some(mime);
        }
    }

    // RIFF and ISO-BMFF carry their real type a few bytes in.
    if head.len() >= 12 && head.starts_with(b"RIFF") {
        return match &head[8..12] {
            b"WEBP" => Some("image/webp"),
            b"WAVE" => Some("audio/wav"),
            b"AVI " => Some("video/x-msvideo"),
            _ => None,
        };
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return match &head[8..12] {
            b"heic" | b"heix" | b"hevc" | b"mif1" => Some("image/heic"),
            b"avif" => Some("image/avif"),
            b"qt  " => Some("video/quicktime"),
            _ => Some("video/mp4"),
        };
    }
    None
}

/// A NUL in the sniff window means binary; everything else that decodes as
/// UTF-8 is treated as text. This is what makes extensionless files work.
pub(crate) fn looks_like_text(head: &[u8]) -> bool {
    if head.is_empty() {
        return true;
    }
    if head.contains(&0) {
        return false;
    }
    // A head slice usually ends mid-character, so validate only the part that
    // is definitely whole.
    let end = utf8_prefix_len(head);
    std::str::from_utf8(&head[..end]).is_ok()
}

/// Length of the longest prefix that cannot contain a truncated character.
fn utf8_prefix_len(head: &[u8]) -> usize {
    let mut end = head.len();
    let floor = end.saturating_sub(4);
    while end > floor && (head[end - 1] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    if end > floor && end > 0 {
        let lead = head[end - 1];
        let needed = if lead & 0b1000_0000 == 0 {
            1
        } else if lead & 0b1110_0000 == 0b1100_0000 {
            2
        } else if lead & 0b1111_0000 == 0b1110_0000 {
            3
        } else if lead & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            1
        };
        if head.len() - (end - 1) < needed {
            return end - 1;
        }
    }
    head.len()
}

fn extension_of(name: &OsStr) -> String {
    Path::new(name)
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// `(content_type, preview)` for a known extension.
fn by_extension(ext: &str) -> Option<(&'static str, PreviewKind)> {
    use PreviewKind::{Metadata, Native, Quicklook};
    let entry = match ext {
        "png" => ("image/png", Native),
        "jpg" | "jpeg" => ("image/jpeg", Native),
        "gif" => ("image/gif", Native),
        "webp" => ("image/webp", Native),
        "bmp" => ("image/bmp", Native),
        "ico" => ("image/x-icon", Native),
        "avif" => ("image/avif", Native),
        "svg" => ("image/svg+xml", Native),
        "heic" => ("image/heic", Quicklook),
        "heif" => ("image/heif", Quicklook),
        "tif" | "tiff" => ("image/tiff", Quicklook),
        "psd" => ("image/vnd.adobe.photoshop", Quicklook),

        "pdf" => ("application/pdf", Native),

        "mp4" | "m4v" => ("video/mp4", Native),
        "mov" => ("video/quicktime", Native),
        "webm" => ("video/webm", Native),
        "mkv" => ("video/x-matroska", Native),
        "avi" => ("video/x-msvideo", Native),

        "mp3" => ("audio/mpeg", Native),
        "m4a" => ("audio/mp4", Native),
        "wav" => ("audio/wav", Native),
        "flac" => ("audio/flac", Native),
        "ogg" | "oga" | "opus" => ("audio/ogg", Native),
        "aiff" | "aif" => ("audio/aiff", Native),

        "txt" | "log" | "text" => ("text/plain", Native),
        "md" | "markdown" | "mdx" => ("text/markdown", Native),
        "csv" => ("text/csv", Native),
        "tsv" => ("text/tab-separated-values", Native),
        "html" | "htm" | "xhtml" => ("text/html", Native),
        "xml" | "plist" | "svgz" => ("application/xml", Native),
        "json" | "jsonc" | "json5" => ("application/json", Native),
        "yaml" | "yml" | "toml" | "ini" | "conf" | "cfg" | "env" => ("text/plain", Native),
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "css" | "scss" | "less" => {
            ("text/plain", Native)
        }
        "py" | "rb" | "rs" | "go" | "c" | "h" | "cc" | "cpp" | "hpp" | "java" | "kt" | "swift"
        | "php" | "pl" | "lua" | "sql" | "sh" | "bash" | "zsh" => ("text/plain", Native),

        "rtf" => ("application/rtf", Quicklook),
        "doc" => ("application/msword", Quicklook),
        "xls" => ("application/vnd.ms-excel", Quicklook),
        "ppt" => ("application/vnd.ms-powerpoint", Quicklook),
        "sketch" | "ai" | "eps" | "dwg" => (OCTET, Quicklook),
        "ttf" => ("font/ttf", Quicklook),
        "otf" => ("font/otf", Quicklook),
        "woff" => ("font/woff", Quicklook),
        "woff2" => ("font/woff2", Quicklook),

        "zip" => ("application/zip", Metadata),
        "tar" => ("application/x-tar", Metadata),
        "gz" | "tgz" => ("application/gzip", Metadata),
        "bz2" => ("application/x-bzip2", Metadata),
        "xz" => ("application/x-xz", Metadata),
        "zst" => ("application/zstd", Metadata),
        "7z" => ("application/x-7z-compressed", Metadata),
        "rar" => ("application/vnd.rar", Metadata),
        "so" | "dylib" | "o" | "a" | "wasm" | "class" | "pyc" => (OCTET, Metadata),
        "db" | "sqlite" | "sqlite3" => ("application/vnd.sqlite3", Metadata),
        _ => {
            if let Some((_, mime)) = ZIP_DOCUMENTS.iter().find(|(key, _)| *key == ext) {
                (*mime, Quicklook)
            } else {
                return None;
            }
        }
    };
    Some(entry)
}

/// Classify with bytes in hand. This is the authoritative form.
pub(crate) fn classify(name: &OsStr, head: &[u8]) -> Classification {
    let ext = extension_of(name);
    let never_open = NEVER_OPEN.contains(&ext.as_str());

    // Executable content is decided first and cannot be overridden by anything
    // the name claims.
    if is_executable_magic(head) {
        return Classification {
            content_type: OCTET,
            source: "magic",
            preview: PreviewKind::Metadata,
            open_allowed: false,
        };
    }

    let extension_entry = by_extension(&ext);

    if head.starts_with(b"PK\x03\x04") {
        let document = ZIP_DOCUMENTS.iter().find(|(key, _)| *key == ext);
        return match document {
            Some((_, mime)) => Classification {
                content_type: mime,
                source: "magic",
                preview: PreviewKind::Quicklook,
                open_allowed: !never_open,
            },
            // A zip whose extension does not name a document it could be — a
            // `.jar`, an `.apk`, a bare archive. Nothing to render, nothing to
            // launch.
            None => Classification {
                content_type: "application/zip",
                source: "magic",
                preview: PreviewKind::Metadata,
                open_allowed: false,
            },
        };
    }

    if let Some(mime) = sniff_magic(head) {
        // The extension still decides *how* to preview when both agree on the
        // family; otherwise fall back to what the bytes imply.
        let preview = match extension_entry {
            Some((ext_mime, kind)) if ext_mime == mime => kind,
            _ => preview_for_type(mime),
        };
        return Classification {
            content_type: mime,
            source: "magic",
            preview,
            open_allowed: !never_open && type_is_openable(mime),
        };
    }

    if let Some((mime, preview)) = extension_entry {
        // The name says text and the bytes do not disagree.
        return Classification {
            content_type: mime,
            source: "extension",
            preview,
            open_allowed: !never_open && type_is_openable(mime) && looks_plausible(mime, head),
        };
    }

    if looks_like_text(head) && !head.is_empty() {
        return Classification {
            content_type: "text/plain",
            source: "magic",
            preview: PreviewKind::Native,
            open_allowed: !never_open,
        };
    }

    Classification {
        content_type: OCTET,
        source: "unknown",
        preview: PreviewKind::Quicklook,
        open_allowed: false,
    }
}

/// A text-ish extension on binary content is a lie; refuse to launch it.
fn looks_plausible(mime: &str, head: &[u8]) -> bool {
    if mime.starts_with("text/") || mime == "application/json" || mime == "application/xml" {
        return looks_like_text(head);
    }
    true
}

fn preview_for_type(mime: &str) -> PreviewKind {
    if mime.starts_with("text/") {
        return PreviewKind::Native;
    }
    match mime {
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/x-icon"
        | "image/avif" | "image/svg+xml" | "application/pdf" | "video/mp4" | "video/webm"
        | "video/quicktime" | "audio/mpeg" | "audio/wav" | "audio/flac" | "audio/ogg"
        | "audio/mp4" | "application/json" | "application/xml" => PreviewKind::Native,
        "application/gzip"
        | "application/zip"
        | "application/x-7z-compressed"
        | "application/vnd.rar"
        | "application/x-xz"
        | "application/zstd"
        | "application/vnd.sqlite3" => PreviewKind::Metadata,
        _ => PreviewKind::Quicklook,
    }
}

/// Classify from the name alone, for callers with no bytes (`fs.stat`).
///
/// Never reports `open_allowed`: without bytes there is no evidence, and a
/// guess is not a basis for launching anything.
pub(crate) fn classify_by_extension(name: &OsStr) -> Classification {
    let ext = extension_of(name);
    match by_extension(&ext) {
        Some((mime, preview)) => Classification {
            content_type: mime,
            source: "extension",
            preview,
            open_allowed: false,
        },
        None => Classification {
            content_type: OCTET,
            source: "unknown",
            preview: PreviewKind::Quicklook,
            open_allowed: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn classify_name(name: &str, head: &[u8]) -> Classification {
        classify(&OsString::from(name), head)
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
    const MACH_O: &[u8] = &[0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01];
    const ELF: &[u8] = b"\x7FELF\x02\x01\x01\x00";
    const ZIP: &[u8] = b"PK\x03\x04\x14\x00\x00\x00";

    #[test]
    fn magic_beats_a_lying_extension() {
        // The whole point of sniffing: a name is a claim, bytes are evidence.
        let png_as_text = classify_name("notes.txt", PNG);
        assert_eq!(png_as_text.content_type, "image/png");
        assert_eq!(png_as_text.source, "magic");
    }

    #[test]
    fn an_executable_named_as_a_document_is_never_openable() {
        for (name, head) in [("notes.txt", MACH_O), ("report.pdf", ELF)] {
            let result = classify_name(name, head);
            assert!(
                !result.open_allowed,
                "{name} must not be openable with executable content"
            );
            assert_eq!(result.preview, PreviewKind::Metadata);
        }
    }

    #[test]
    fn a_shebang_script_is_executable_whatever_it_is_called() {
        let result = classify_name("harmless.txt", b"#!/bin/sh\nrm -rf /\n");
        assert!(!result.open_allowed);
        assert_eq!(result.preview, PreviewKind::Metadata);
    }

    #[test]
    fn url_indirection_files_are_refused_despite_sniffing_as_text() {
        // These are the classic allowlist bypass: a tiny plist that hands an
        // arbitrary scheme to LaunchServices.
        for name in [
            "link.webloc",
            "site.inetloc",
            "doc.fileloc",
            "go.url",
            "s.lnk",
            "run.command",
        ] {
            let result = classify_name(name, b"<?xml version=\"1.0\"?><plist/>");
            assert!(!result.open_allowed, "{name} must never be openable");
        }
    }

    #[test]
    fn shell_scripts_are_readable_but_not_launchable() {
        let result = classify_name("deploy.sh", b"echo hello\n");
        assert_eq!(result.preview, PreviewKind::Native);
        assert!(!result.open_allowed);
    }

    #[test]
    fn zip_containers_open_only_when_the_extension_names_a_document() {
        let docx = classify_name("report.docx", ZIP);
        assert!(docx.open_allowed);
        assert_eq!(docx.preview, PreviewKind::Quicklook);
        assert!(docx.content_type.contains("wordprocessingml"));

        let keynote = classify_name("deck.key", ZIP);
        assert!(keynote.open_allowed);

        // Same bytes, different name: an executable archive is not a document.
        for name in ["tool.jar", "app.apk", "bundle.zip"] {
            let result = classify_name(name, ZIP);
            assert!(!result.open_allowed, "{name} must not be openable");
            assert_eq!(result.content_type, "application/zip");
        }
    }

    #[test]
    fn ordinary_media_and_documents_are_openable() {
        assert!(classify_name("photo.png", PNG).open_allowed);
        assert!(classify_name("doc.pdf", b"%PDF-1.7\n").open_allowed);
        assert!(classify_name("notes.txt", b"plain words\n").open_allowed);
    }

    #[test]
    fn a_text_extension_over_binary_content_is_not_openable() {
        // No magic matched, extension says text, bytes say otherwise.
        let result = classify_name("notes.txt", &[0x00, 0x01, 0x02, 0x03]);
        assert!(!result.open_allowed);
    }

    #[test]
    fn container_formats_resolve_through_their_brand() {
        assert_eq!(
            classify_name("a.bin", b"RIFF\x00\x00\x00\x00WEBPVP8 ").content_type,
            "image/webp"
        );
        assert_eq!(
            classify_name("a.bin", b"RIFF\x00\x00\x00\x00WAVEfmt ").content_type,
            "audio/wav"
        );
        assert_eq!(
            classify_name("a.bin", b"\x00\x00\x00\x18ftypheic").content_type,
            "image/heic"
        );
        assert_eq!(
            classify_name("a.bin", b"\x00\x00\x00\x18ftypisom").content_type,
            "video/mp4"
        );
    }

    #[test]
    fn extensionless_text_is_recognised_by_its_bytes() {
        let result = classify_name("Makefile", b"all:\n\tcargo build\n");
        assert_eq!(result.content_type, "text/plain");
        assert_eq!(result.preview, PreviewKind::Native);
    }

    #[test]
    fn unknown_binary_falls_through_to_the_host_renderer() {
        // The daemon may still have a QuickLook generator for it; guessing
        // "nothing" here would hide previews for every format we did not list.
        let result = classify_name("drawing.dwg", &[0xAC, 0x10, 0x00, 0x00]);
        assert_eq!(result.preview, PreviewKind::Quicklook);
        assert!(!result.open_allowed);
    }

    #[test]
    fn empty_content_is_not_mistaken_for_anything() {
        let result = classify_name("mystery", b"");
        assert!(!result.open_allowed);
    }

    #[test]
    fn looks_like_text_rejects_nul_and_accepts_utf8() {
        assert!(looks_like_text(b"hello world"));
        assert!(!looks_like_text(b"hel\x00lo"));
        assert!(looks_like_text("héllo ok".as_bytes()));
    }

    #[test]
    fn looks_like_text_tolerates_a_truncated_trailing_character() {
        // A sniff window ends at an arbitrary offset, very often mid-character.
        let full = "done 🎉".as_bytes();
        assert!(looks_like_text(&full[..full.len() - 2]));
    }

    #[test]
    fn extension_only_classification_never_grants_open() {
        // `fs.stat` has no bytes, so it has no evidence, so it grants nothing.
        for name in ["photo.png", "doc.pdf", "notes.txt"] {
            assert!(!classify_by_extension(&OsString::from(name)).open_allowed);
        }
        assert_eq!(
            classify_by_extension(&OsString::from("photo.png")).content_type,
            "image/png"
        );
    }

    #[test]
    fn preview_kinds_have_stable_wire_names() {
        assert_eq!(PreviewKind::Native.as_wire(), "native");
        assert_eq!(PreviewKind::Quicklook.as_wire(), "quicklook");
        assert_eq!(PreviewKind::Metadata.as_wire(), "metadata");
    }
}
