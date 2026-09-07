//! Encrypted-at-rest, append-only log of committed scrollback lines.
//!
//! History is a document, not a byte stream: the emulator commits each line
//! exactly once, at the moment it scrolls off the screen, serialized as
//! styled text (see `sessiond::emulator::HistoryEvent`). Those batches are
//! encrypted with ChaCha20-Poly1305 before they ever touch disk and appended
//! here. Replay is a pure concatenation of the retained batches — no
//! checkpoints, no raw repaint bytes, no geometry walking; the live screen is
//! synthesized separately by the worker at request time.
//!
//! The log is segmented purely for eviction: whole oldest segments are
//! deleted when the resource budget is exceeded, which drops the oldest
//! committed lines in blocks. Because batches are self-contained (each opens
//! with a full SGR reset), a replay starting at any segment renders cleanly.
//! An app-driven scrollback wipe (`CSI 3 J`) maps to [`ScrollbackLog::truncate_all`],
//! which physically unlinks every retained segment — cleared history stops
//! existing on disk, it is not merely skipped on render.
//!
//! Growth is bounded by one conservative resource budget. It charges exact
//! ciphertext/framing bytes, actual allocated file/directory blocks with safe
//! floors and metadata overhead, twice the replay representation (returned
//! bytes plus decryption/framing scratch), and retained segment/path
//! bookkeeping. Segment filenames occupy a fixed ring and a hard count cap
//! bounds inodes and directory growth. A record that fails conservative
//! preflight is rejected before a file is created, and replay never returns a
//! partial segment.
//!
//! Key model: the key is generated per worker process, lives only in locked
//! worker memory (`secret::SecretBytes`), and is never persisted. A worker
//! that dies takes its scrollback keys with it — the session process died with
//! the PTY anyway, so the log has nothing left to replay; leftover ciphertext
//! is unreadable and is unlinked on the next start. docs/SESSIOND.md
//! discusses host-key and device-sealed alternatives.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use zeroize::Zeroize;

use super::secret;

/// Charged resource bytes per segment before rotation opens the next one.
pub const DEFAULT_SEGMENT_BYTES: u64 = 256 * 1024;
/// Total scrollback resource budget across all segments.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
/// Hard inode/file-count bound independent of the byte budget.
pub const MAX_SEGMENTS: usize = 128;

const ALLOCATION_FLOOR_BYTES: u64 = 4 * 1024;
const FILE_METADATA_CHARGE_BYTES: u64 = 1024;
const DIRECTORY_METADATA_CHARGE_BYTES: u64 = 1024;
const SEGMENT_PHYSICAL_FLOOR: u64 = ALLOCATION_FLOOR_BYTES + FILE_METADATA_CHARGE_BYTES;

/// A batch of committed history lines (serialized styled text).
pub const KIND_HISTORY: u8 = 3;

/// The geometry marker heading each section of a worker replay stream:
/// `CSI 8 ; rows ; cols t` (xterm window ops syntax; xterm.js parses but does
/// not apply it, so the web client splits on it).
pub fn geometry_marker(cols: u16, rows: u16) -> Vec<u8> {
    format!("\x1b[8;{rows};{cols}t").into_bytes()
}

/// In-band sentinel that opens a committed-line-history replay stream
/// (immediately after the head geometry marker). An APC string, so a
/// terminal that has it written verbatim ignores it. Clients that recognize
/// it render the history section as flowing lines instead of geometry-walking
/// raw bytes; clients that don't fall back to the legacy chunk walk.
pub const REPLAY_HISTORY_SENTINEL: &[u8] = b"\x1b_sp:h1\x1b\\";

/// The head of a worker replay: the geometry marker, the history sentinel,
/// then [`emulator::RETURN_TO_ASCII`](super::emulator::RETURN_TO_ASCII).
/// Committed lines are painted as already-mapped glyphs, exactly like the
/// screen chunk, so a consumer the previous screen's tail left in a
/// line-drawing set is returned to ASCII before it renders them (#61). The
/// clients' reseed clear leads with the same bytes; this covers a client
/// that has not learned to, and any terminal the stream is written to.
pub fn replay_head(cols: u16, rows: u16) -> Vec<u8> {
    let mut head = geometry_marker(cols, rows);
    head.extend_from_slice(REPLAY_HISTORY_SENTINEL);
    head.extend_from_slice(super::emulator::RETURN_TO_ASCII);
    head
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
    /// Bytes this segment contributes to a replay.
    replay_bytes: u64,
    /// Disk + twice replay bytes. The second replay copy covers the largest
    /// transient during decrypt/framing without pretending plaintext is absent.
    record_charge: u64,
    /// Allocated file blocks (not logical length), with an allocation floor and
    /// conservative inode/directory-entry overhead.
    physical_charge: u64,
}

pub struct ScrollbackLog {
    dir: PathBuf,
    cipher: ChaCha20Poly1305,
    /// Strictly monotonic record counter; doubles as the AEAD nonce, which is
    /// safe because the key is unique per worker process. Never reset — not
    /// even by [`Self::truncate_all`] — so nonces cannot repeat.
    seq: u64,
    segments: Vec<Segment>,
    active: Option<File>,
    segment_bytes: u64,
    max_bytes: u64,
    /// Cumulative history plaintext bytes ever appended (observability).
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
        if segment_bytes == 0 || max_bytes == 0 {
            bail!("scrollback segment and total budgets must be non-zero");
        }
        if max_bytes > DEFAULT_MAX_LOG_BYTES {
            bail!(
                "scrollback total budget {max_bytes} exceeds the hard {} byte resource limit",
                DEFAULT_MAX_LOG_BYTES
            );
        }
        crate::platform::create_private_dir_all(dir)
            .with_context(|| format!("creating and validating {}", dir.display()))?;
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
        };
        log.begin_segment(1)?;
        Ok(log)
    }

    /// Append one batch of committed history lines, rotating and evicting as
    /// the budget requires.
    pub fn append_history(&mut self, plaintext: &[u8]) -> Result<()> {
        if plaintext.is_empty() {
            return Ok(());
        }
        let disk_bytes = record_disk_bytes(plaintext.len())?;
        let replay_bytes = plaintext.len() as u64;
        let record_charge = record_charge(disk_bytes, replay_bytes)?;
        self.trim_for_additional(record_charge, false)?;
        self.append_record(KIND_HISTORY, plaintext)?;
        let due = {
            let seg = self
                .segments
                .last_mut()
                .context("scrollback has no active segment")?;
            seg.disk_bytes += disk_bytes;
            seg.replay_bytes += replay_bytes;
            seg.record_charge += record_charge;
            seg.physical_charge = segment_physical_charge(&seg.path)?;
            seg.record_charge >= self.segment_bytes
        };
        self.total_logged += plaintext.len() as u64;
        if due {
            let next = self.segments.last().map(|s| s.index + 1).unwrap_or(1);
            self.begin_segment(next)?;
        }
        self.trim_to_budget()?;
        Ok(())
    }

    /// Physically drop all retained history (the app erased its scrollback).
    /// Every segment file is unlinked and a fresh empty segment begins; the
    /// record sequence keeps counting so AEAD nonces never repeat.
    pub fn truncate_all(&mut self) -> Result<()> {
        let next = self.segments.last().map(|s| s.index + 1).unwrap_or(1);
        self.active.take();
        for seg in &self.segments {
            unlink_segment(&seg.path)?;
        }
        self.segments.clear();
        self.begin_segment(next)
    }

    /// Cumulative history plaintext bytes ever appended.
    pub fn total_logged(&self) -> u64 {
        self.total_logged
    }

    /// Decrypt and concatenate the newest run of whole committed-line batches
    /// whose plaintext fits `max_bytes`. Batches are self-contained (each
    /// opens with a full SGR reset), so replay may begin at ANY record
    /// boundary: a budget smaller than the newest segment — or even than a
    /// single batch — degrades to less (or no) history instead of failing.
    /// Reconnect seeds must never wedge on history volume; only integrity
    /// failures (authentication, sequence) fail the replay closed.
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

        // Walk segments newest-first, decrypting each in full (contiguity is
        // validated per segment) and keeping the newest batches that fit.
        let mut kept: Vec<Vec<u8>> = Vec::new(); // newest-first
        let mut kept_bytes: u64 = 0;
        let mut budget_full = false;
        // Seqs are strictly increasing across the whole log (truncation
        // retires ranges but never resets the counter), so walking
        // newest-first every segment must sit strictly below the floor set
        // by the segments already consumed.
        let mut floor_seq: Option<u64> = None;
        for seg in self.segments.iter().rev() {
            if budget_full {
                break;
            }
            let data = match fs::read(&seg.path)
                .with_context(|| format!("reading {}", seg.path.display()))
            {
                Ok(data) => data,
                Err(error) => {
                    wipe_batches(kept);
                    return Err(error);
                }
            };
            let mut batches: Vec<Vec<u8>> = Vec::new();
            let mut offset = 0usize;
            let mut first_seq: Option<u64> = None;
            let mut expect_seq: Option<u64> = None;
            while offset < data.len() {
                let (kind, seq, ct) = match parse_record(&data, &mut offset)
                    .with_context(|| format!("parsing {}", seg.path.display()))
                {
                    Ok(record) => record,
                    Err(error) => {
                        wipe_batches(kept);
                        wipe_batches(batches);
                        return Err(error);
                    }
                };
                if expect_seq.is_some_and(|expected| seq != expected) {
                    wipe_batches(kept);
                    wipe_batches(batches);
                    bail!(
                        "scrollback sequence gap in {} (expected {:?}, got {seq})",
                        seg.path.display(),
                        expect_seq
                    );
                }
                first_seq.get_or_insert(seq);
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
                        wipe_batches(kept);
                        wipe_batches(batches);
                        bail!(
                            "scrollback record failed authentication in {}",
                            seg.path.display()
                        );
                    }
                };
                if kind == KIND_HISTORY {
                    batches.push(plaintext);
                } else {
                    plaintext.zeroize();
                }
            }
            let last_seq = expect_seq.map(|next| next - 1);
            if let (Some(last), Some(floor)) = (last_seq, floor_seq) {
                if last >= floor {
                    wipe_batches(kept);
                    wipe_batches(batches);
                    bail!(
                        "scrollback sequence overlap in {} ({last} >= floor {floor})",
                        seg.path.display()
                    );
                }
            }
            if let Some(first) = first_seq {
                floor_seq = Some(first);
            }
            for mut batch in batches.into_iter().rev() {
                if budget_full || kept_bytes.saturating_add(batch.len() as u64) > max_bytes {
                    budget_full = true;
                    batch.zeroize();
                    continue;
                }
                kept_bytes += batch.len() as u64;
                kept.push(batch);
            }
        }

        let capacity = usize::try_from(kept_bytes).context("replay size does not fit usize")?;
        let mut out = Vec::with_capacity(capacity);
        for batch in kept.iter().rev() {
            out.extend_from_slice(batch);
        }
        wipe_batches(kept);
        debug_assert!(out.len() as u64 <= max_bytes);
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

    /// Actual allocated file/directory blocks where the platform exposes
    /// them, otherwise logical length rounded to a conservative block floor.
    pub fn allocated_disk_bytes(&self) -> u64 {
        allocated_path_bytes(&self.dir)
            .unwrap_or(ALLOCATION_FLOOR_BYTES)
            .saturating_add(
                self.segments
                    .iter()
                    .map(|segment| {
                        allocated_path_bytes(&segment.path).unwrap_or(ALLOCATION_FLOOR_BYTES)
                    })
                    .sum::<u64>(),
            )
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Conservative total resource charge currently retained by the log.
    pub fn budget_bytes(&self) -> u64 {
        self.fixed_memory_charge()
            .saturating_add(self.segments.iter().map(|s| s.record_charge).sum::<u64>())
            .saturating_add(self.segments.iter().map(|s| s.physical_charge).sum::<u64>())
            .saturating_add(directory_physical_charge(&self.dir))
            .saturating_add(self.segment_memory_charge())
    }

    /// Remove every segment file. Called when the session exits.
    pub fn destroy(mut self) {
        self.active.take();
        for seg in &self.segments {
            let _ = fs::remove_file(&seg.path);
        }
        let _ = fs::remove_dir(&self.dir);
    }

    fn begin_segment(&mut self, index: u64) -> Result<()> {
        let path = self.dir.join(segment_name(index));
        self.validate_new_segment(&path)?;

        // Reuse a fixed filename ring and unlink the oldest file before its
        // slot is reused. This bounds both live inodes and directory entries.
        while self.segments.len() >= MAX_SEGMENTS {
            let oldest = self.segments[0].path.clone();
            unlink_segment(&oldest)?;
            self.segments.remove(0);
        }

        let file = crate::platform::create_private_file_new(&path)
            .with_context(|| format!("creating {}", path.display()))?;
        let physical_charge = match segment_physical_charge(&path) {
            Ok(charge) => charge,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        if let Some(active) = self.active.as_mut() {
            active.flush().ok();
        }
        self.active = Some(file);
        self.segments.push(Segment {
            index,
            path,
            disk_bytes: 0,
            replay_bytes: 0,
            record_charge: 0,
            physical_charge,
        });
        self.trim_to_budget()?;
        Ok(())
    }

    fn trim_to_budget(&mut self) -> Result<()> {
        while self.segments.len() > 1 {
            self.segments.shrink_to_fit();
            if self.segments.len() <= MAX_SEGMENTS && self.budget_bytes() <= self.max_bytes {
                break;
            }
            let path = self.segments[0].path.clone();
            unlink_segment(&path)?;
            self.segments.remove(0);
        }
        self.segments.shrink_to_fit();
        if self.segments.len() > MAX_SEGMENTS {
            bail!("scrollback retained more than {MAX_SEGMENTS} segments");
        }
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

    /// Preflight for a fresh (empty) segment before its file is created.
    fn validate_new_segment(&self, path: &Path) -> Result<()> {
        let minimum = self
            .fixed_memory_charge()
            .saturating_add(directory_physical_charge(&self.dir))
            .saturating_add(std::mem::size_of::<Segment>() as u64)
            .saturating_add(path_heap_charge(path))
            .saturating_add(SEGMENT_PHYSICAL_FLOOR);
        if minimum > self.max_bytes {
            bail!(
                "a scrollback segment requires at least {minimum} charged bytes, exceeding total budget {}",
                self.max_bytes
            );
        }
        Ok(())
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

fn segment_physical_charge(path: &Path) -> Result<u64> {
    Ok(allocated_path_bytes(path)?
        .max(ALLOCATION_FLOOR_BYTES)
        .saturating_add(FILE_METADATA_CHARGE_BYTES))
}

fn directory_physical_charge(path: &Path) -> u64 {
    allocated_path_bytes(path)
        .unwrap_or(ALLOCATION_FLOOR_BYTES)
        .max(ALLOCATION_FLOOR_BYTES)
        .saturating_add(DIRECTORY_METADATA_CHARGE_BYTES)
}

#[cfg(unix)]
fn allocated_path_bytes(path: &Path) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    Ok(metadata.blocks().saturating_mul(512))
}

#[cfg(not(unix))]
fn allocated_path_bytes(path: &Path) -> Result<u64> {
    let len = fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .len();
    Ok(len.div_ceil(ALLOCATION_FLOOR_BYTES) * ALLOCATION_FLOOR_BYTES)
}

fn wipe_batches(batches: Vec<Vec<u8>>) {
    for mut batch in batches {
        batch.zeroize();
    }
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
    format!("{SEGMENT_PREFIX}{:08}.log", index % MAX_SEGMENTS as u64)
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

    fn log_dir(temporary: &tempfile::TempDir) -> PathBuf {
        #[cfg(windows)]
        {
            // The runner owns its TEMP root policy. Exercise the production
            // contract with a child whose canonical owner-only DACL SPAWN D
            // creates itself instead of accepting or repairing that root.
            let dir = temporary.path().join("scrollback");
            crate::platform::create_private_dir_all(&dir).unwrap();
            dir
        }
        #[cfg(not(windows))]
        {
            temporary.path().to_path_buf()
        }
    }

    fn new_log(dir: &Path, segment: u64, max: u64) -> ScrollbackLog {
        let key = secret::SecretBytes::random(32).unwrap();
        ScrollbackLog::with_limits(dir, &key, segment, max).unwrap()
    }

    #[test]
    fn append_and_replay_round_trip() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let mut log = new_log(&dir, 1024 * 1024, 8 * 1024 * 1024);
        log.append_history(b"hello \r\n").unwrap();
        log.append_history(b"world\r\n").unwrap();
        assert_eq!(log.total_logged(), 15);
        let replay = log.replay(1024 * 1024).unwrap();
        assert_eq!(replay, b"hello \r\nworld\r\n");
    }

    #[test]
    fn truncate_unlinks_every_segment_and_appends_continue() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let mut log = new_log(&dir, 64, 8 * 1024 * 1024);
        for i in 0..8 {
            log.append_history(format!("wiped-line-{i}\r\n").as_bytes())
                .unwrap();
        }
        assert!(log.segment_count() > 1, "test needs multiple segments");
        log.truncate_all().unwrap();
        assert_eq!(log.segment_count(), 1);
        assert_eq!(log.replay(1024).unwrap(), b"");
        // Nothing pre-truncate survives on disk, even encrypted length-wise:
        // exactly one empty segment file remains.
        let entries: Vec<_> = fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(fs::metadata(entries[0].path()).unwrap().len(), 0);
        // The log keeps working afterwards, and seq never regressed.
        log.append_history(b"fresh\r\n").unwrap();
        assert_eq!(log.replay(1024).unwrap(), b"fresh\r\n");
    }

    #[test]
    fn plaintext_never_hits_disk() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let mut log = new_log(&dir, 1024 * 1024, 8 * 1024 * 1024);
        let line_marker = b"SUPER-SECRET-MARKER-0451".as_slice();
        log.append_history(line_marker).unwrap();
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let mut contents = Vec::new();
            File::open(entry.path())
                .unwrap()
                .read_to_end(&mut contents)
                .unwrap();
            assert!(
                !contents
                    .windows(line_marker.len())
                    .any(|window| window == line_marker),
                "plaintext found in {}",
                entry.path().display()
            );
        }
        assert_eq!(log.replay(1024).unwrap(), line_marker);
    }

    #[test]
    fn rotation_bounds_growth_and_keeps_replay_coherent() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let max = 32 * 1024;
        let mut log = new_log(&dir, 1024, max);
        let chunk = vec![b'x'; 512];
        let mut appended = 0u64;
        for _ in 0..32 {
            log.append_history(&chunk).unwrap();
            appended += chunk.len() as u64;
        }
        assert_eq!(log.total_logged(), appended);
        assert!(log.budget_bytes() <= max);
        assert!(log.disk_bytes() <= max);
        assert!(log.allocated_disk_bytes() <= max);
        assert!(log.segment_count() >= 1);
        // Only segment files that are tracked exist on disk.
        let on_disk = fs::read_dir(&dir).unwrap().count();
        assert_eq!(on_disk, log.segment_count());
        // Replay decrypts cleanly and is pure retained content.
        let replay = log.replay(u64::MAX).unwrap();
        assert!(replay.iter().all(|&b| b == b'x'));
        assert!(replay.len() as u64 <= max);
    }

    #[test]
    fn replay_budget_prefers_newest_segments() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        // Tiny segment budget: every batch rotates into its own segment.
        let mut log = new_log(&dir, 8, 1024 * 1024);
        log.append_history(b"old-old-old!").unwrap();
        log.append_history(b"new-new-new!").unwrap();
        assert!(log.segment_count() >= 2);
        let replay = log.replay(b"new-new-new!".len() as u64).unwrap();
        assert_eq!(replay, b"new-new-new!");
        let replay = log.replay(1024).unwrap();
        assert_eq!(replay, b"old-old-old!new-new-new!");
    }

    #[test]
    fn tampered_record_fails_closed() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let mut log = new_log(&dir, 1024 * 1024, 8 * 1024 * 1024);
        log.append_history(b"authentic bytes").unwrap();
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
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        fs::write(dir.join("seg-00000042.log"), b"dead ciphertext").unwrap();
        let log = new_log(&dir, 1024, 16 * 1024);
        assert_eq!(log.segment_count(), 1);
        assert!(!dir.join("seg-00000042.log").exists());
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
        )
        .is_err());
    }

    #[test]
    fn small_budget_degrades_to_newest_batches_never_fails() {
        // The reconnect-seed regression: a 64 KiB replay request against a
        // newest segment holding more than that wedged every attach. Budgets
        // now select whole batches newest-first and simply return less.
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let mut log = new_log(&dir, 1024 * 1024, 8 * 1024 * 1024);
        log.append_history(b"batch-one\r\n").unwrap();
        log.append_history(b"batch-two\r\n").unwrap();
        log.append_history(b"batch-three\r\n").unwrap();
        assert_eq!(log.segment_count(), 1, "one segment holds all batches");

        // Budget for the newest batch only.
        assert_eq!(log.replay(13).unwrap(), b"batch-three\r\n");
        // Budget for the newest two.
        assert_eq!(log.replay(24).unwrap(), b"batch-two\r\nbatch-three\r\n");
        // Budget smaller than any single batch: empty history, not an error.
        assert_eq!(log.replay(4).unwrap(), b"");
        // Full budget: everything, oldest first.
        assert_eq!(
            log.replay(1024).unwrap(),
            b"batch-one\r\nbatch-two\r\nbatch-three\r\n"
        );
    }

    #[test]
    fn small_budget_takes_newest_suffix_across_segments() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        // Tiny segment budget: every batch rotates into its own segment.
        let mut log = new_log(&dir, 8, 1024 * 1024);
        log.append_history(b"seg-a\r\n").unwrap();
        log.append_history(b"seg-b\r\n").unwrap();
        log.append_history(b"seg-c\r\n").unwrap();
        assert!(log.segment_count() >= 3);
        assert_eq!(log.replay(7).unwrap(), b"seg-c\r\n");
        assert_eq!(log.replay(14).unwrap(), b"seg-b\r\nseg-c\r\n");
    }

    #[test]
    fn oversized_batch_beyond_total_budget_fails_closed() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let max = 16 * 1024;
        let mut log = new_log(&dir, 256, max);
        log.append_history(b"still-valid\r\n").unwrap();
        let before = log.replay(1024).unwrap();
        let oversized = vec![b'X'; 32 * 1024];
        assert!(log.append_history(&oversized).is_err());
        assert_eq!(log.replay(1024).unwrap(), before);
        assert!(log.budget_bytes() <= max);
    }

    #[test]
    fn tiny_batch_flood_bounds_files_blocks_and_replay() {
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let max = DEFAULT_MAX_LOG_BYTES;
        let mut log = new_log(&dir, 1, max);

        for index in 0..4096u16 {
            let byte = b'a' + (index % 26) as u8;
            log.append_history(&[byte]).unwrap();
            if index.is_multiple_of(127) {
                assert!(log.segment_count() <= MAX_SEGMENTS);
                assert!(log.budget_bytes() <= max);
                assert!(log.allocated_disk_bytes() <= max);
            }
        }

        let on_disk = fs::read_dir(&dir).unwrap().count();
        assert_eq!(on_disk, log.segment_count());
        assert!(on_disk <= MAX_SEGMENTS);
        assert!(log.allocated_disk_bytes() > 0);
        assert!(log.allocated_disk_bytes() <= log.budget_bytes());
        assert!(log.budget_bytes() <= max);
        assert_eq!(log.total_logged(), 4096);

        let replay = log.replay(u64::MAX).unwrap();
        assert!(!replay.is_empty());
        assert!(replay.iter().any(|b| b.is_ascii_lowercase()));
        assert!(replay.len() as u64 <= max);
    }

    #[test]
    fn truncate_flood_bounds_inodes() {
        // An adversary alternating tiny appends with ED 3 wipes must not grow
        // files or leak inodes.
        let temporary = tempdir().unwrap();
        let dir = log_dir(&temporary);
        let mut log = new_log(&dir, 64, 16 * 1024);
        for i in 0..512u16 {
            log.append_history(format!("l{i}\r\n").as_bytes()).unwrap();
            if i.is_multiple_of(3) {
                log.truncate_all().unwrap();
            }
        }
        assert!(log.segment_count() <= MAX_SEGMENTS);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), log.segment_count());
        assert!(log.budget_bytes() <= 16 * 1024);
    }
}
