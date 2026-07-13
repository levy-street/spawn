//! Encrypted-at-rest, append-only scrollback log with checkpoint markers.
//!
//! PTY output is encrypted the moment it leaves the read buffer
//! ("encrypt-on-read at the PTY boundary") and only ever hits disk as
//! ChaCha20-Poly1305 ciphertext. The log is segmented: a new segment begins
//! with a CHECKPOINT record, and the worker nudges the PTY (SIGWINCH jiggle)
//! right after rotating so the bytes that follow a checkpoint contain a fresh
//! full-screen repaint. Replay therefore starts at a segment boundary and
//! yields a coherent screen for full-screen apps, while line-oriented output
//! replays trivially.
//!
//! Growth is bounded: when the total plaintext budget is exceeded, whole
//! oldest segments are deleted (never partial records, never the newest
//! segment).
//!
//! Key model: the key is generated per worker process, lives only in locked
//! worker memory (`secret::SecretBytes`), and is never persisted. A worker
//! that dies takes its scrollback keys with it — the agent process died with
//! the PTY anyway, so the log has nothing left to replay; leftover ciphertext
//! is unreadable and is unlinked on the next start. docs/SESSIOND.md
//! discusses host-key and device-sealed alternatives.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use zeroize::Zeroize;

use super::secret;

/// Plaintext bytes per segment before a checkpoint rotation is due.
pub const DEFAULT_SEGMENT_BYTES: u64 = 256 * 1024;
/// Total plaintext budget across all segments before oldest are dropped.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

pub const KIND_OUTPUT: u8 = 1;
pub const KIND_CHECKPOINT: u8 = 2;

/// Per-record header: `u32 LE ciphertext_len | u8 kind | u64 LE seq`.
const RECORD_HEADER_LEN: usize = 4 + 1 + 8;
/// AEAD tag overhead per record.
const TAG_LEN: usize = 16;

struct Segment {
    index: u64,
    path: PathBuf,
    /// Total OUTPUT plaintext bytes in this segment.
    plaintext_bytes: u64,
}

pub struct ScrollbackLog {
    dir: PathBuf,
    cipher: ChaCha20Poly1305,
    /// Strictly monotonic record counter; doubles as the AEAD nonce, which is
    /// safe because the key is unique per worker process.
    seq: u64,
    segments: Vec<Segment>,
    active: File,
    segment_bytes: u64,
    max_bytes: u64,
    /// Cumulative OUTPUT plaintext bytes ever appended (the replay watermark).
    total_logged: u64,
}

impl ScrollbackLog {
    pub fn new(dir: &Path, key: &secret::SecretBytes) -> Result<Self> {
        Self::with_limits(dir, key, DEFAULT_SEGMENT_BYTES, DEFAULT_MAX_LOG_BYTES)
    }

    pub fn with_limits(
        dir: &Path,
        key: &secret::SecretBytes,
        segment_bytes: u64,
        max_bytes: u64,
    ) -> Result<Self> {
        if key.as_slice().len() != 32 {
            bail!("scrollback key must be 32 bytes");
        }
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("chmod 700 {}", dir.display()))?;
        }
        // A fresh worker means a fresh key: ciphertext from a previous run is
        // unreadable by construction. Unlink it rather than let it accrete.
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(SEGMENT_PREFIX)
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }

        let cipher = ChaCha20Poly1305::new(Key::from_slice(key.as_slice()));
        let mut log = Self {
            dir: dir.to_path_buf(),
            cipher,
            seq: 0,
            segments: Vec::new(),
            // placeholder; begin_segment replaces it immediately
            active: File::create(dir.join(segment_name(0)))?,
            segment_bytes,
            max_bytes,
            total_logged: 0,
        };
        let _ = fs::remove_file(dir.join(segment_name(0)));
        log.begin_segment(1)?;
        Ok(log)
    }

    /// Append PTY output. Returns true when a checkpoint rotation is due —
    /// the caller should call [`rotate`](Self::rotate) and then trigger a
    /// repaint so the new segment opens with a full redraw.
    pub fn append_output(&mut self, plaintext: &[u8]) -> Result<bool> {
        if plaintext.is_empty() {
            return Ok(false);
        }
        self.append_record(KIND_OUTPUT, plaintext)?;
        let seg = self.segments.last_mut().expect("active segment");
        seg.plaintext_bytes += plaintext.len() as u64;
        self.total_logged += plaintext.len() as u64;
        Ok(seg.plaintext_bytes >= self.segment_bytes)
    }

    /// Close the active segment and open the next one (which begins with a
    /// CHECKPOINT record), then drop oldest segments beyond the budget.
    pub fn rotate(&mut self) -> Result<()> {
        let next = self.segments.last().map(|s| s.index + 1).unwrap_or(1);
        self.begin_segment(next)?;
        self.trim();
        Ok(())
    }

    /// Cumulative OUTPUT plaintext bytes ever appended.
    pub fn total_logged(&self) -> u64 {
        self.total_logged
    }

    /// Decrypt and concatenate output from the newest run of whole segments
    /// whose plaintext fits `max_bytes` (always at least the newest segment).
    /// The result begins at a checkpoint boundary.
    pub fn replay(&mut self, max_bytes: u64) -> Result<Vec<u8>> {
        self.active.flush().ok();
        let mut start = self.segments.len().saturating_sub(1);
        let mut budget = 0u64;
        for (i, seg) in self.segments.iter().enumerate().rev() {
            if budget + seg.plaintext_bytes > max_bytes && i != self.segments.len() - 1 {
                break;
            }
            budget += seg.plaintext_bytes;
            start = i;
            if budget > max_bytes {
                break;
            }
        }

        let mut out = Vec::new();
        let mut expect_seq: Option<u64> = None;
        for seg in &self.segments[start..] {
            let data =
                fs::read(&seg.path).with_context(|| format!("reading {}", seg.path.display()))?;
            let mut offset = 0usize;
            while offset < data.len() {
                let (kind, seq, ct) = parse_record(&data, &mut offset)
                    .with_context(|| format!("parsing {}", seg.path.display()))?;
                if let Some(expected) = expect_seq {
                    if seq != expected {
                        secret::wipe(&mut out);
                        bail!(
                            "scrollback sequence gap in {} (expected {expected}, got {seq})",
                            seg.path.display()
                        );
                    }
                }
                expect_seq = Some(seq + 1);
                let nonce_bytes = nonce_for(seq);
                let mut plaintext = match self.cipher.decrypt(
                    Nonce::from_slice(&nonce_bytes),
                    Payload {
                        msg: ct,
                        aad: &aad_for(kind, seq),
                    },
                ) {
                    Ok(p) => p,
                    Err(_) => {
                        secret::wipe(&mut out);
                        bail!(
                            "scrollback record failed authentication in {}",
                            seg.path.display()
                        );
                    }
                };
                if kind == KIND_OUTPUT {
                    out.extend_from_slice(&plaintext);
                }
                plaintext.zeroize();
            }
        }
        Ok(out)
    }

    /// Total ciphertext bytes currently on disk (for observability/tests).
    pub fn disk_bytes(&self) -> u64 {
        self.segments
            .iter()
            .filter_map(|s| fs::metadata(&s.path).ok())
            .map(|m| m.len())
            .sum()
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Remove every segment file. Called when the agent exits.
    pub fn destroy(self) {
        for seg in &self.segments {
            let _ = fs::remove_file(&seg.path);
        }
        let _ = fs::remove_dir(&self.dir);
    }

    fn begin_segment(&mut self, index: u64) -> Result<()> {
        let path = self.dir.join(segment_name(index));
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("creating {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        self.active.flush().ok();
        self.active = file;
        self.segments.push(Segment {
            index,
            path,
            plaintext_bytes: 0,
        });
        self.append_record(KIND_CHECKPOINT, b"")?;
        Ok(())
    }

    fn trim(&mut self) {
        while self.segments.len() > 1 {
            let total: u64 = self.segments.iter().map(|s| s.plaintext_bytes).sum();
            if total <= self.max_bytes {
                break;
            }
            let oldest = self.segments.remove(0);
            let _ = fs::remove_file(&oldest.path);
        }
    }

    fn append_record(&mut self, kind: u8, plaintext: &[u8]) -> Result<()> {
        let seq = self.seq;
        let nonce_bytes = nonce_for(seq);
        let ct = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: &aad_for(kind, seq),
                },
            )
            .map_err(|_| anyhow::anyhow!("scrollback encryption failed"))?;
        let mut header = [0u8; RECORD_HEADER_LEN];
        header[..4].copy_from_slice(&(ct.len() as u32).to_le_bytes());
        header[4] = kind;
        header[5..].copy_from_slice(&seq.to_le_bytes());
        self.active
            .write_all(&header)
            .and_then(|_| self.active.write_all(&ct))
            .context("appending scrollback record")?;
        self.seq += 1;
        Ok(())
    }
}

const SEGMENT_PREFIX: &str = "seg-";

fn segment_name(index: u64) -> String {
    format!("{SEGMENT_PREFIX}{index:08}.log")
}

fn nonce_for(seq: u64) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&seq.to_le_bytes());
    nonce
}

fn aad_for(kind: u8, seq: u64) -> [u8; 9] {
    let mut aad = [0u8; 9];
    aad[0] = kind;
    aad[1..].copy_from_slice(&seq.to_le_bytes());
    aad
}

fn parse_record<'a>(data: &'a [u8], offset: &mut usize) -> Result<(u8, u64, &'a [u8])> {
    if data.len() - *offset < RECORD_HEADER_LEN {
        bail!("truncated record header");
    }
    let header = &data[*offset..*offset + RECORD_HEADER_LEN];
    let ct_len = u32::from_le_bytes(header[..4].try_into().expect("checked length")) as usize;
    let kind = header[4];
    let seq = u64::from_le_bytes(header[5..].try_into().expect("checked length"));
    if ct_len < TAG_LEN {
        bail!("ciphertext shorter than AEAD tag");
    }
    let body_start = *offset + RECORD_HEADER_LEN;
    if data.len() - body_start < ct_len {
        bail!("truncated record body");
    }
    *offset = body_start + ct_len;
    Ok((kind, seq, &data[body_start..body_start + ct_len]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::tempdir;

    fn new_log(dir: &Path, segment: u64, max: u64) -> ScrollbackLog {
        let key = secret::SecretBytes::random(32).unwrap();
        ScrollbackLog::with_limits(dir, &key, segment, max).unwrap()
    }

    #[test]
    fn append_and_replay_round_trip() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        log.append_output(b"hello ").unwrap();
        log.append_output(b"world\r\n").unwrap();
        assert_eq!(log.total_logged(), 13);
        let replay = log.replay(1024 * 1024).unwrap();
        assert_eq!(replay, b"hello world\r\n");
    }

    #[test]
    fn plaintext_never_hits_disk() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        let marker = b"SUPER-SECRET-MARKER-0451";
        log.append_output(marker).unwrap();
        for entry in fs::read_dir(dir.path()).unwrap().flatten() {
            let mut contents = Vec::new();
            File::open(entry.path())
                .unwrap()
                .read_to_end(&mut contents)
                .unwrap();
            assert!(
                !contents
                    .windows(marker.len())
                    .any(|window| window == marker),
                "plaintext marker found in {}",
                entry.path().display()
            );
        }
        // ...but it decrypts fine.
        let replay = log.replay(1024).unwrap();
        assert_eq!(replay, marker);
    }

    #[test]
    fn rotation_bounds_growth_and_keeps_replay_coherent() {
        let dir = tempdir().unwrap();
        // 1 KiB segments, 3 KiB budget.
        let mut log = new_log(dir.path(), 1024, 3 * 1024);
        let chunk = vec![b'x'; 512];
        let mut appended = 0u64;
        for _ in 0..32 {
            if log.append_output(&chunk).unwrap() {
                log.rotate().unwrap();
            }
            appended += chunk.len() as u64;
        }
        assert_eq!(log.total_logged(), appended);
        let total_plaintext: u64 = log.segments.iter().map(|s| s.plaintext_bytes).sum();
        assert!(
            total_plaintext <= 3 * 1024 + 1024,
            "budget not enforced: {total_plaintext}"
        );
        assert!(log.segment_count() >= 1);
        // Only segment files that are tracked exist on disk.
        let on_disk = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(on_disk, log.segment_count());
        // Replay decrypts cleanly from a checkpoint boundary.
        let replay = log.replay(u64::MAX).unwrap();
        assert_eq!(replay.len() as u64, total_plaintext);
        assert!(replay.iter().all(|&b| b == b'x'));
    }

    #[test]
    fn replay_budget_prefers_newest_segments() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 8, 1024 * 1024);
        log.append_output(b"old-old-old!").unwrap();
        log.rotate().unwrap();
        log.append_output(b"new-new-new!").unwrap();
        // Budget covers only one segment: expect just the newest.
        let replay = log.replay(12).unwrap();
        assert_eq!(replay, b"new-new-new!");
        // Large budget: everything.
        let replay = log.replay(1024).unwrap();
        assert_eq!(replay, b"old-old-old!new-new-new!");
    }

    #[test]
    fn tampered_record_fails_closed() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        log.append_output(b"authentic bytes").unwrap();
        let seg_path = log.segments.last().unwrap().path.clone();
        drop(log.active.flush());
        let mut data = fs::read(&seg_path).unwrap();
        let last = data.len() - 1;
        data[last] ^= 0x5a;
        fs::write(&seg_path, data).unwrap();
        assert!(log.replay(1024).is_err());
    }

    #[test]
    fn stale_segments_from_previous_run_are_unlinked() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("seg-00000042.log"), b"dead ciphertext").unwrap();
        let log = new_log(dir.path(), 1024, 4096);
        assert_eq!(log.segment_count(), 1);
        assert!(!dir.path().join("seg-00000042.log").exists());
    }
}
