//! Encrypted-at-rest, append-only scrollback log with stateful checkpoints.
//!
//! PTY output is encrypted before it is written to this log and only ever
//! hits disk as ChaCha20-Poly1305 ciphertext. The log is segmented: a new segment begins
//! with a CHECKPOINT record carrying the geometry and an emulator-serialized
//! screen state (see `sessiond::emulator`), so a replay starting at any
//! segment boundary opens with an exact synthesized repaint — the agent
//! process is never signaled or disturbed to produce one. A PTY resize
//! forces a checkpoint (replacing the active segment when it holds no output
//! yet, so resize storms cannot grow the log), which makes **every segment
//! single-geometry and self-contained**.
//!
//! Replay output is a self-describing ANSI stream of geometry-tagged chunks:
//! each included segment contributes `CSI 8 ; rows ; cols t` + its checkpoint
//! repaint + its output. Checkpoint repaints are idempotent (full-row
//! painting, no ED), so mid-stream chunks converge rather than duplicate, and
//! a consumer may seed a live terminal from the final chunk alone.
//!
//! Growth is bounded by one conservative resource budget. It charges exact
//! ciphertext/framing bytes, twice the replay representation (returned bytes
//! plus decryption/framing scratch), and retained segment/path bookkeeping.
//! Whole oldest segments are deleted; a checkpoint that cannot fit by itself
//! is rejected before a file is created, and replay never returns a partial
//! segment.
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
use zeroize::{Zeroize, Zeroizing};

use super::secret;

/// Additional charged resource bytes per segment before a checkpoint rotation
/// is due. The segment's checkpoint is charged separately.
pub const DEFAULT_SEGMENT_BYTES: u64 = 256 * 1024;
/// Total scrollback resource budget across all segments.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

pub const KIND_OUTPUT: u8 = 1;
pub const KIND_CHECKPOINT: u8 = 2;

/// Terminal geometry plus the emulator-serialized screen state that
/// reconstructs it; written at the head of every segment.
pub struct Checkpoint<'a> {
    pub cols: u16,
    pub rows: u16,
    pub state: &'a [u8],
}

/// The geometry marker heading every replay chunk: `CSI 8 ; rows ; cols t`
/// (xterm window ops syntax; xterm.js parses but does not apply it, so the
/// web client splits on it and applies geometry via `term.resize()`).
pub fn geometry_marker(cols: u16, rows: u16) -> Vec<u8> {
    format!("\x1b[8;{rows};{cols}t").into_bytes()
}

/// Per-record header: `u32 LE ciphertext_len | u8 kind | u64 LE seq`.
const RECORD_HEADER_LEN: usize = 4 + 1 + 8;
/// AEAD tag overhead per record.
const TAG_LEN: usize = 16;

struct Segment {
    index: u64,
    path: PathBuf,
    /// Exact encrypted record bytes retained on disk.
    disk_bytes: u64,
    /// Bytes this segment contributes to a styled replay.
    replay_bytes: u64,
    /// Disk + twice replay bytes. The second replay copy covers the largest
    /// transient during decrypt/framing without pretending plaintext is absent.
    record_charge: u64,
    /// Rotation threshold: checkpoint charge plus configured segment charge.
    rotate_at: u64,
}

pub struct ScrollbackLog {
    dir: PathBuf,
    cipher: ChaCha20Poly1305,
    /// Strictly monotonic record counter; doubles as the AEAD nonce, which is
    /// safe because the key is unique per worker process.
    seq: u64,
    segments: Vec<Segment>,
    active: Option<File>,
    segment_bytes: u64,
    max_bytes: u64,
    /// Cumulative OUTPUT plaintext bytes ever appended (the replay watermark).
    total_logged: u64,
    /// Current geometry, tracked to drop no-op resize records.
    geometry: (u16, u16),
}

impl ScrollbackLog {
    pub fn new(dir: &Path, key: &secret::SecretBytes, initial: Checkpoint<'_>) -> Result<Self> {
        Self::with_limits(
            dir,
            key,
            DEFAULT_SEGMENT_BYTES,
            DEFAULT_MAX_LOG_BYTES,
            initial,
        )
    }

    pub fn with_limits(
        dir: &Path,
        key: &secret::SecretBytes,
        segment_bytes: u64,
        max_bytes: u64,
        initial: Checkpoint<'_>,
    ) -> Result<Self> {
        if key.as_slice().len() != 32 {
            bail!("scrollback key must be 32 bytes");
        }
        if segment_bytes == 0 || max_bytes == 0 {
            bail!("scrollback segment and total budgets must be non-zero");
        }
        if max_bytes > DEFAULT_MAX_LOG_BYTES {
            bail!(
                "scrollback total budget {max_bytes} exceeds the hard {} byte resource limit",
                DEFAULT_MAX_LOG_BYTES
            );
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
            segments: Vec::with_capacity(1),
            active: None,
            segment_bytes,
            max_bytes,
            total_logged: 0,
            geometry: (initial.cols, initial.rows),
        };
        log.begin_segment(1, &initial)?;
        Ok(log)
    }

    /// Append PTY output. Returns true when a checkpoint rotation is due —
    /// the caller should serialize its emulator state and call
    /// [`rotate`](Self::rotate). The agent process is not involved.
    pub fn append_output(&mut self, plaintext: &[u8]) -> Result<bool> {
        if plaintext.is_empty() {
            return Ok(false);
        }
        let disk_bytes = record_disk_bytes(plaintext.len())?;
        let replay_bytes = plaintext.len() as u64;
        let record_charge = record_charge(disk_bytes, replay_bytes)?;
        self.trim_for_additional(record_charge, false)?;
        self.append_record(KIND_OUTPUT, plaintext)?;
        let seg = self
            .segments
            .last_mut()
            .context("scrollback has no active segment")?;
        seg.disk_bytes += disk_bytes;
        seg.replay_bytes += replay_bytes;
        seg.record_charge += record_charge;
        self.total_logged += plaintext.len() as u64;
        Ok(seg.record_charge >= seg.rotate_at)
    }

    /// Record a PTY geometry change by checkpointing at the new geometry:
    /// rotate when the active segment holds output, otherwise replace the
    /// active segment's checkpoint in place — a resize storm therefore
    /// rewrites one small file instead of growing the log. No-op when the
    /// geometry is unchanged.
    pub fn resize_checkpoint(&mut self, checkpoint: &Checkpoint<'_>) -> Result<()> {
        if self.geometry == (checkpoint.cols, checkpoint.rows) {
            return Ok(());
        }
        let active = self
            .segments
            .last()
            .context("scrollback has no active segment")?;
        if active.record_charge == active.rotate_at.saturating_sub(self.segment_bytes) {
            self.validate_checkpoint(checkpoint, active.index)?;
            let index = active.index;
            let path = active.path.clone();
            self.active.take();
            unlink_segment(&path)?;
            self.segments.pop();
            self.segments.shrink_to_fit();
            let result = self.begin_segment(index, checkpoint);
            if result.is_ok() {
                self.geometry = (checkpoint.cols, checkpoint.rows);
            }
            return result;
        }
        self.rotate(checkpoint)
    }

    /// Close the active segment and open the next one headed by `checkpoint`,
    /// then drop oldest segments beyond the budget.
    pub fn rotate(&mut self, checkpoint: &Checkpoint<'_>) -> Result<()> {
        let next = self.segments.last().map(|s| s.index + 1).unwrap_or(1);
        self.begin_segment(next, checkpoint)?;
        self.geometry = (checkpoint.cols, checkpoint.rows);
        Ok(())
    }

    /// Cumulative OUTPUT plaintext bytes ever appended.
    pub fn total_logged(&self) -> u64 {
        self.total_logged
    }

    /// Decrypt and stitch a self-describing replay stream from the newest run
    /// of whole segments whose plaintext fits `max_bytes` (always at least
    /// the newest segment). Every included segment contributes a geometry
    /// marker + its checkpoint repaint + its output, so each chunk between
    /// markers is self-contained and the final chunk alone reconstructs the
    /// current screen at the current geometry.
    pub fn replay(&mut self, max_bytes: u64) -> Result<Vec<u8>> {
        if max_bytes == 0 {
            bail!("replay budget must be non-zero");
        }
        if self.segments.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(active) = self.active.as_mut() {
            active.flush().ok();
        }
        let mut start = self.segments.len().saturating_sub(1);
        let mut budget = 0u64;
        for (i, seg) in self.segments.iter().enumerate().rev() {
            if seg.replay_bytes > max_bytes && i == self.segments.len() - 1 {
                bail!(
                    "newest complete replay segment is {} bytes, exceeding request budget {max_bytes}",
                    seg.replay_bytes
                );
            }
            if budget.saturating_add(seg.replay_bytes) > max_bytes {
                break;
            }
            budget += seg.replay_bytes;
            start = i;
        }

        let capacity = usize::try_from(budget).context("replay budget does not fit usize")?;
        let mut out = Vec::with_capacity(capacity);
        // Seqs must be contiguous within a segment and strictly increasing
        // across segment boundaries (in-place checkpoint replacement retires
        // seq ranges, so cross-segment gaps are legitimate).
        let mut min_seq: u64 = 0;
        for seg in &self.segments[start..] {
            let data = match fs::read(&seg.path)
                .with_context(|| format!("reading {}", seg.path.display()))
            {
                Ok(data) => data,
                Err(error) => {
                    secret::wipe(&mut out);
                    return Err(error);
                }
            };
            let mut offset = 0usize;
            let mut expect_seq: Option<u64> = None;
            while offset < data.len() {
                let (kind, seq, ct) = match parse_record(&data, &mut offset)
                    .with_context(|| format!("parsing {}", seg.path.display()))
                {
                    Ok(record) => record,
                    Err(error) => {
                        secret::wipe(&mut out);
                        return Err(error);
                    }
                };
                let valid = match expect_seq {
                    Some(expected) => seq == expected,
                    None => seq >= min_seq,
                };
                if !valid {
                    secret::wipe(&mut out);
                    bail!(
                        "scrollback sequence gap in {} (expected {:?}/min {min_seq}, got {seq})",
                        seg.path.display(),
                        expect_seq
                    );
                }
                expect_seq = Some(seq + 1);
                min_seq = seq + 1;
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
                match kind {
                    KIND_OUTPUT => out.extend_from_slice(&plaintext),
                    KIND_CHECKPOINT => {
                        let (cols, rows, state) = match decode_checkpoint(&plaintext) {
                            Ok(parts) => parts,
                            Err(e) => {
                                plaintext.zeroize();
                                secret::wipe(&mut out);
                                return Err(e.context(format!(
                                    "decoding checkpoint in {}",
                                    seg.path.display()
                                )));
                            }
                        };
                        out.extend_from_slice(&geometry_marker(cols, rows));
                        out.extend_from_slice(state);
                    }
                    _ => {}
                }
                plaintext.zeroize();
            }
        }
        if out.len() as u64 > max_bytes {
            secret::wipe(&mut out);
            bail!("replay exceeded its admitted response budget");
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

    /// Conservative total resource charge currently retained by the log.
    pub fn budget_bytes(&self) -> u64 {
        self.fixed_memory_charge()
            .saturating_add(self.segments.iter().map(|s| s.record_charge).sum::<u64>())
            .saturating_add(self.segment_memory_charge())
    }

    /// Remove every segment file. Called when the agent exits.
    pub fn destroy(mut self) {
        self.active.take();
        for seg in &self.segments {
            let _ = fs::remove_file(&seg.path);
        }
        let _ = fs::remove_dir(&self.dir);
    }

    fn begin_segment(&mut self, index: u64, checkpoint: &Checkpoint<'_>) -> Result<()> {
        let path = self.dir.join(segment_name(index));
        let (disk_bytes, replay_bytes, checkpoint_charge) =
            self.validate_checkpoint(checkpoint, index)?;

        let mut payload = Zeroizing::new(Vec::with_capacity(4 + checkpoint.state.len()));
        payload.extend_from_slice(&checkpoint.cols.to_le_bytes());
        payload.extend_from_slice(&checkpoint.rows.to_le_bytes());
        payload.extend_from_slice(checkpoint.state);
        let seq = self.seq;
        let mut record = encrypt_record(&self.cipher, KIND_CHECKPOINT, seq, &payload)?;

        let mut file = match OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("creating {}", path.display()))
        {
            Ok(file) => file,
            Err(error) => {
                record.zeroize();
                return Err(error);
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        if let Err(error) = file
            .write_all(&record)
            .with_context(|| format!("writing checkpoint to {}", path.display()))
        {
            record.zeroize();
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        record.zeroize();
        if let Some(active) = self.active.as_mut() {
            active.flush().ok();
        }
        self.active = Some(file);
        self.segments.push(Segment {
            index,
            path,
            disk_bytes,
            replay_bytes,
            record_charge: checkpoint_charge,
            rotate_at: checkpoint_charge.saturating_add(self.segment_bytes),
        });
        self.seq = self
            .seq
            .checked_add(1)
            .context("scrollback sequence exhausted")?;
        self.trim_to_budget()?;
        Ok(())
    }

    fn trim_to_budget(&mut self) -> Result<()> {
        while self.segments.len() > 1 {
            self.segments.shrink_to_fit();
            if self.budget_bytes() <= self.max_bytes {
                break;
            }
            let path = self.segments[0].path.clone();
            unlink_segment(&path)?;
            self.segments.remove(0);
        }
        self.segments.shrink_to_fit();
        if self.budget_bytes() > self.max_bytes {
            bail!(
                "newest scrollback segment requires {} bytes, exceeding total budget {}",
                self.budget_bytes(),
                self.max_bytes
            );
        }
        Ok(())
    }

    fn trim_for_additional(&mut self, additional: u64, allow_empty: bool) -> Result<()> {
        let minimum = usize::from(!allow_empty);
        while self.segments.len() > minimum {
            self.segments.shrink_to_fit();
            if self.budget_bytes().saturating_add(additional) <= self.max_bytes {
                return Ok(());
            }
            let path = self.segments[0].path.clone();
            unlink_segment(&path)?;
            self.segments.remove(0);
        }
        self.segments.shrink_to_fit();
        if self.budget_bytes().saturating_add(additional) > self.max_bytes {
            bail!(
                "scrollback record requires {additional} additional bytes beyond total budget {}",
                self.max_bytes
            );
        }
        Ok(())
    }

    fn validate_checkpoint(
        &self,
        checkpoint: &Checkpoint<'_>,
        index: u64,
    ) -> Result<(u64, u64, u64)> {
        let payload_len = checkpoint
            .state
            .len()
            .checked_add(4)
            .context("checkpoint length overflow")?;
        let disk_bytes = record_disk_bytes(payload_len)?;
        let replay_bytes = u64::try_from(checkpoint.state.len())?
            .checked_add(geometry_marker(checkpoint.cols, checkpoint.rows).len() as u64)
            .context("checkpoint replay length overflow")?;
        let charge = record_charge(disk_bytes, replay_bytes)?;
        let path = self.dir.join(segment_name(index));
        let minimum = self
            .fixed_memory_charge()
            .saturating_add(std::mem::size_of::<Segment>() as u64)
            .saturating_add(path_heap_charge(&path))
            .saturating_add(charge);
        if minimum > self.max_bytes {
            bail!(
                "checkpoint requires at least {minimum} charged bytes, exceeding total budget {}",
                self.max_bytes
            );
        }
        Ok((disk_bytes, replay_bytes, charge))
    }

    fn fixed_memory_charge(&self) -> u64 {
        (std::mem::size_of::<Self>() as u64).saturating_add(path_heap_charge(&self.dir))
    }

    fn segment_memory_charge(&self) -> u64 {
        let slots = (self.segments.capacity() * std::mem::size_of::<Segment>()) as u64;
        slots.saturating_add(
            self.segments
                .iter()
                .map(|segment| path_heap_charge(&segment.path))
                .sum::<u64>(),
        )
    }

    fn append_record(&mut self, kind: u8, plaintext: &[u8]) -> Result<()> {
        let seq = self.seq;
        let mut record = encrypt_record(&self.cipher, kind, seq, plaintext)?;
        let result = self
            .active
            .as_mut()
            .context("scrollback has no active file")?
            .write_all(&record)
            .context("appending scrollback record");
        record.zeroize();
        result?;
        self.seq = self
            .seq
            .checked_add(1)
            .context("scrollback sequence exhausted")?;
        Ok(())
    }
}

fn record_disk_bytes(plaintext_len: usize) -> Result<u64> {
    let ciphertext_len = plaintext_len
        .checked_add(TAG_LEN)
        .context("scrollback ciphertext length overflow")?;
    if ciphertext_len > u32::MAX as usize {
        bail!("scrollback record exceeds u32 framing limit");
    }
    let total = RECORD_HEADER_LEN
        .checked_add(ciphertext_len)
        .context("scrollback framed record length overflow")?;
    Ok(total as u64)
}

fn record_charge(disk_bytes: u64, replay_bytes: u64) -> Result<u64> {
    disk_bytes
        .checked_add(
            replay_bytes
                .checked_mul(2)
                .context("scrollback replay charge overflow")?,
        )
        .context("scrollback record charge overflow")
}

fn path_heap_charge(path: &Path) -> u64 {
    let bytes = path.as_os_str().to_string_lossy().len().max(1);
    bytes.next_power_of_two() as u64
}

fn unlink_segment(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("removing {}", path.display())),
    }
}

fn encrypt_record(
    cipher: &ChaCha20Poly1305,
    kind: u8,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let expected_disk = usize::try_from(record_disk_bytes(plaintext.len())?)?;
    let nonce_bytes = nonce_for(seq);
    let mut ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: &aad_for(kind, seq),
            },
        )
        .map_err(|_| anyhow::anyhow!("scrollback encryption failed"))?;
    let mut record = Vec::with_capacity(expected_disk);
    record.extend_from_slice(&(ciphertext.len() as u32).to_le_bytes());
    record.push(kind);
    record.extend_from_slice(&seq.to_le_bytes());
    record.append(&mut ciphertext);
    debug_assert_eq!(record.len(), expected_disk);
    Ok(record)
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

fn decode_checkpoint(payload: &[u8]) -> Result<(u16, u16, &[u8])> {
    if payload.len() < 4 {
        bail!("checkpoint payload shorter than geometry header");
    }
    let cols = u16::from_le_bytes([payload[0], payload[1]]);
    let rows = u16::from_le_bytes([payload[2], payload[3]]);
    Ok((cols, rows, &payload[4..]))
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

    fn ckpt(state: &[u8]) -> Checkpoint<'_> {
        Checkpoint {
            cols: 80,
            rows: 24,
            state,
        }
    }

    fn new_log(dir: &Path, segment: u64, max: u64) -> ScrollbackLog {
        let key = secret::SecretBytes::random(32).unwrap();
        ScrollbackLog::with_limits(dir, &key, segment, max, ckpt(b"")).unwrap()
    }

    fn marker() -> Vec<u8> {
        geometry_marker(80, 24)
    }

    #[test]
    fn append_and_replay_round_trip() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        log.append_output(b"hello ").unwrap();
        log.append_output(b"world\r\n").unwrap();
        assert_eq!(log.total_logged(), 13);
        let replay = log.replay(1024 * 1024).unwrap();
        assert_eq!(replay, [marker().as_slice(), b"hello world\r\n"].concat());
    }

    #[test]
    fn replay_opens_with_checkpoint_state() {
        let dir = tempdir().unwrap();
        let key = secret::SecretBytes::random(32).unwrap();
        let mut log = ScrollbackLog::with_limits(
            dir.path(),
            &key,
            1024,
            8 * 1024,
            Checkpoint {
                cols: 120,
                rows: 40,
                state: b"REPAINT",
            },
        )
        .unwrap();
        log.append_output(b"tail").unwrap();
        let replay = log.replay(1024).unwrap();
        assert_eq!(
            replay,
            [geometry_marker(120, 40).as_slice(), b"REPAINT", b"tail"].concat()
        );
    }

    #[test]
    fn resize_rotates_when_the_segment_has_output() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        log.append_output(b"before").unwrap();
        let resized = Checkpoint {
            cols: 120,
            rows: 40,
            state: b"STATE-AT-120",
        };
        log.resize_checkpoint(&resized).unwrap();
        log.resize_checkpoint(&resized).unwrap(); // dedupe: unchanged geometry
        log.append_output(b"after").unwrap();
        assert_eq!(log.segment_count(), 2);
        let replay = log.replay(1024).unwrap();
        assert_eq!(
            replay,
            [
                marker().as_slice(),
                b"before",
                geometry_marker(120, 40).as_slice(),
                b"STATE-AT-120",
                b"after"
            ]
            .concat()
        );
        // Watermark counts output only.
        assert_eq!(log.total_logged(), 11);
    }

    #[test]
    fn resize_storm_replaces_the_empty_segment_in_place() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        log.append_output(b"content").unwrap();
        for i in 0..50u16 {
            log.resize_checkpoint(&Checkpoint {
                cols: 100 + i,
                rows: 40,
                state: b"S",
            })
            .unwrap();
        }
        // One rotation for the first change, in-place replacement after.
        assert_eq!(log.segment_count(), 2);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
        let replay = log.replay(1024).unwrap();
        assert_eq!(
            replay,
            [
                marker().as_slice(),
                b"content",
                geometry_marker(149, 40).as_slice(),
                b"S"
            ]
            .concat()
        );
    }

    #[test]
    fn plaintext_never_hits_disk() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        let output_marker = b"SUPER-SECRET-MARKER-0451".as_slice();
        let state_marker = b"CHECKPOINT-STATE-SECRET-9932".as_slice();
        log.append_output(output_marker).unwrap();
        log.rotate(&ckpt(state_marker)).unwrap();
        for entry in fs::read_dir(dir.path()).unwrap().flatten() {
            let mut contents = Vec::new();
            File::open(entry.path())
                .unwrap()
                .read_to_end(&mut contents)
                .unwrap();
            for secret_bytes in [output_marker, state_marker] {
                assert!(
                    !contents
                        .windows(secret_bytes.len())
                        .any(|window| window == secret_bytes),
                    "plaintext found in {}",
                    entry.path().display()
                );
            }
        }
        // ...but it decrypts fine (including the rotated-in checkpoint state).
        let replay = log.replay(1024).unwrap();
        assert_eq!(
            replay,
            [
                marker().as_slice(),
                output_marker,
                marker().as_slice(),
                state_marker
            ]
            .concat()
        );
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
                log.rotate(&ckpt(b"")).unwrap();
            }
            appended += chunk.len() as u64;
        }
        assert_eq!(log.total_logged(), appended);
        assert!(log.budget_bytes() <= 3 * 1024);
        assert!(log.disk_bytes() <= 3 * 1024);
        assert!(log.segment_count() >= 1);
        // Only segment files that are tracked exist on disk.
        let on_disk = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(on_disk, log.segment_count());
        // Replay decrypts cleanly; each segment contributes one geometry
        // marker (checkpoint states are empty in this test).
        let replay = log.replay(u64::MAX).unwrap();
        let retained_output = replay.iter().filter(|&&b| b == b'x').count() as u64;
        let expected_len = marker().len() as u64 * log.segment_count() as u64 + retained_output;
        assert_eq!(replay.len() as u64, expected_len);
        assert!(replay.len() as u64 <= 3 * 1024);
    }

    #[test]
    fn replay_budget_prefers_newest_segments() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 8, 1024 * 1024);
        log.append_output(b"old-old-old!").unwrap();
        log.rotate(&ckpt(b"NEW-CKPT-STATE")).unwrap();
        log.append_output(b"new-new-new!").unwrap();
        // Budget covers only one segment: the newest, opened by its own
        // checkpoint state.
        let newest_len = marker().len() + b"NEW-CKPT-STATE".len() + b"new-new-new!".len();
        let replay = log.replay(newest_len as u64).unwrap();
        assert_eq!(
            replay,
            [marker().as_slice(), b"NEW-CKPT-STATE", b"new-new-new!"].concat()
        );
        // Large budget: both segments, each opened by its own checkpoint.
        let replay = log.replay(1024).unwrap();
        assert_eq!(
            replay,
            [
                marker().as_slice(),
                b"old-old-old!",
                marker().as_slice(),
                b"NEW-CKPT-STATE",
                b"new-new-new!"
            ]
            .concat()
        );
    }

    #[test]
    fn tampered_record_fails_closed() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024 * 1024, 8 * 1024 * 1024);
        log.append_output(b"authentic bytes").unwrap();
        let seg_path = log.segments.last().unwrap().path.clone();
        if let Some(active) = log.active.as_mut() {
            drop(active.flush());
        }
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

    #[test]
    fn oversized_checkpoint_is_rejected_without_partial_replay() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 256, 2048);
        log.append_output(b"still-valid").unwrap();
        let before = log.replay(1024).unwrap();
        let files_before = fs::read_dir(dir.path()).unwrap().count();
        let oversized = vec![b'X'; 4096];

        assert!(log
            .rotate(&Checkpoint {
                cols: 400,
                rows: 200,
                state: &oversized,
            })
            .is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), files_before);
        assert_eq!(log.replay(1024).unwrap(), before);
        assert!(log.budget_bytes() <= 2048);
    }

    #[test]
    fn configured_total_budget_cannot_exceed_protocol_limit() {
        let dir = tempdir().unwrap();
        let key = secret::SecretBytes::random(32).unwrap();
        assert!(ScrollbackLog::with_limits(
            dir.path(),
            &key,
            DEFAULT_SEGMENT_BYTES,
            DEFAULT_MAX_LOG_BYTES + 1,
            ckpt(b""),
        )
        .is_err());
    }

    #[test]
    fn request_smaller_than_newest_whole_segment_fails_closed() {
        let dir = tempdir().unwrap();
        let mut log = new_log(dir.path(), 1024, 16 * 1024);
        log.append_output(b"required-tail").unwrap();
        let newest = log.segments.last().unwrap().replay_bytes;
        assert!(newest > 1);
        assert!(log.replay(newest - 1).is_err());
        assert_eq!(log.replay(newest).unwrap().len() as u64, newest);
    }

    #[test]
    fn large_styled_grid_across_many_segments_obeys_every_bound() {
        use super::super::emulator::Emulator;

        let dir = tempdir().unwrap();
        let key = secret::SecretBytes::random(32).unwrap();
        let mut emulator = Emulator::new(400, 200);
        for row in 0..200 {
            emulator.feed(format!("\x1b[{};{}m", 30 + row % 8, 40 + row % 8).as_bytes());
            emulator.feed(&vec![b'A' + (row % 26) as u8; 400]);
            emulator.feed(b"\r\n");
        }
        let mut state = emulator.serialize();
        assert!(
            state.len() > 80_000,
            "styled grid was not adversarially large"
        );

        let max = 1024 * 1024;
        let mut log = ScrollbackLog::with_limits(
            dir.path(),
            &key,
            16 * 1024,
            max,
            Checkpoint {
                cols: 400,
                rows: 200,
                state: &state,
            },
        )
        .unwrap();
        for index in 0..24u8 {
            log.append_output(&vec![index; 8192]).unwrap();
            log.rotate(&Checkpoint {
                cols: 400,
                rows: 200,
                state: &state,
            })
            .unwrap();
            assert!(log.budget_bytes() <= max);
            assert!(log.disk_bytes() <= max);
        }
        let replay = log.replay(u64::MAX).unwrap();
        assert!(replay.len() as u64 <= max);
        assert!(replay.len() < 12 * 1024 * 1024);
        assert!(replay.len() < super::super::wire::MAX_FRAME_LEN - 8);
        assert!(log.disk_bytes().saturating_add(2 * replay.len() as u64) <= max);
        state.zeroize();
    }
}
