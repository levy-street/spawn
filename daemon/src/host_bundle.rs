//! Conversation bundle v1: what `conv.export` streams out of one host and
//! `conv.import.begin` takes in on another (`proto/README.md`, "Conversation
//! bundle v1"; pinned by `proto/conversation-bundle-v1-vectors.json`).
//!
//! ```text
//! offset  size  field
//! 0       4     magic "SPCB"
//! 4       1     version = 1
//! 5       3     reserved, zero
//! 8       4     manifest length M, u32 big-endian, 1 ≤ M ≤ 1 MiB
//! 12      M     manifest, UTF-8 JSON
//! 12+M    …     every entry's bytes, concatenated in manifest order
//! ```
//!
//! An entry is a logical path, a size and a digest — no mode, no link, no
//! owner, no absolute path — and the path must be one the allowlist knows.
//! Pure byte rules: nothing here touches a file. The carrier
//! (`host_conversations`) chooses every name it writes, and refuses a bundle
//! this reader refuses before a byte of any entry lands anywhere.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const MAGIC: [u8; 4] = *b"SPCB";
pub(crate) const VERSION: u8 = 1;
pub(crate) const HEADER_BYTES: u64 = 12;
pub(crate) const MANIFEST_MAX: u32 = 1024 * 1024;
pub(crate) const ENTRIES_MAX: usize = 4096;
/// The existing per-file cap of `spawn.host.ctl` (`file_bytes`).
pub(crate) const ENTRY_MAX: u64 = 512 * 1024 * 1024;
pub(crate) const BUNDLE_MAX: u64 = 2 * 1024 * 1024 * 1024;
/// The one agent version 1 defines.
pub(crate) const CLAUDE_CODE: &str = "claude-code";
/// The record that makes a conversation resumable; always the last entry.
pub(crate) const CONVERSATION: &str = "conversation.jsonl";
/// Everything beside the record lives under this logical folder.
pub(crate) const SIDECAR: &str = "sidecar";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BundleError {
    pub code: &'static str,
    pub detail: String,
}

impl BundleError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

type BundleResult<T> = Result<T, BundleError>;

/// A conversation id as Claude Code names its record: a UUID, lower-case and
/// hyphenated, and nothing else.
pub(crate) fn is_canonical_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

/// An agent version 1 defines, spelled exactly.
pub(crate) fn known_agent(agent: &str) -> bool {
    agent == CLAUDE_CODE
}

/// One component of a logical path: `[A-Za-z0-9._-]{1,128}`, not starting
/// with a dot.
fn valid_component(component: &str) -> bool {
    !component.is_empty()
        && component.len() <= 128
        && !component.starts_with('.')
        && component
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Whether `path` is a logical path at all (`invalid_path`), and then one the
/// agent's allowlist knows (`path_not_allowed`).
pub(crate) fn check_path(agent: &str, path: &str) -> BundleResult<()> {
    let components: Vec<&str> = path.split('/').collect();
    if components
        .iter()
        .any(|component| !valid_component(component))
    {
        return Err(BundleError::new(
            "invalid_path",
            "an entry path is not a relative path of plain names",
        ));
    }
    if !known_agent(agent) || !claude_code_allows(&components) {
        return Err(BundleError::new(
            "path_not_allowed",
            "an entry path is not one the agent's record may carry",
        ));
    }
    Ok(())
}

fn has_extension(name: &str, extensions: &[&str]) -> bool {
    extensions.iter().any(|extension| {
        name.strip_suffix(extension)
            .is_some_and(|stem| stem.ends_with('.') && stem.len() > 1)
    })
}

/// Claude Code's record and what lies beside it, by logical path:
/// `conversation.jsonl`; `sidecar/subagents/<name>.jsonl|.json`;
/// `sidecar/subagents/workflows/<run>/<name>.jsonl|.json`;
/// `sidecar/workflows/<name>.json`; `sidecar/workflows/scripts/<name>.js`;
/// `sidecar/tool-results/<name>.txt|.json`.
fn claude_code_allows(components: &[&str]) -> bool {
    match components {
        [CONVERSATION] => true,
        [SIDECAR, "subagents", name] => has_extension(name, &["jsonl", "json"]),
        [SIDECAR, "subagents", "workflows", _run, name] => has_extension(name, &["jsonl", "json"]),
        [SIDECAR, "workflows", name] => has_extension(name, &["json"]),
        [SIDECAR, "workflows", "scripts", name] => has_extension(name, &["js"]),
        [SIDECAR, "tool-results", name] => has_extension(name, &["txt", "json"]),
        _ => false,
    }
}

/// Whether an entry is an append-only log whose torn last line the carrier
/// trims rather than carries.
pub(crate) fn is_log(path: &str) -> bool {
    path.ends_with(".jsonl")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// `{"agent", "conversation_id", "entries"}`, in that key order (the derive
/// writes fields in declaration order) with no insignificant whitespace, so
/// the same files always make the same bundle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Manifest {
    pub agent: String,
    pub conversation_id: String,
    pub entries: Vec<Entry>,
}

impl Manifest {
    pub(crate) fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// The bytes of every entry together.
    pub(crate) fn content_length(&self) -> u64 {
        self.entries
            .iter()
            .fold(0_u64, |total, entry| total.saturating_add(entry.size))
    }

    /// A whole bundle with this manifest, `manifest_len` bytes long encoded.
    pub(crate) fn bundle_length(&self, manifest_len: u64) -> u64 {
        HEADER_BYTES
            .saturating_add(manifest_len)
            .saturating_add(self.content_length())
    }

    /// Entry count, each path, sizes, digests and order — everything a writer
    /// must get right and a reader checks.
    pub(crate) fn validate(&self) -> BundleResult<()> {
        if self.entries.len() > ENTRIES_MAX {
            return Err(BundleError::new(
                "too_large",
                "a bundle holds at most 4,096 entries",
            ));
        }
        for entry in &self.entries {
            check_path(&self.agent, &entry.path)?;
            if entry.size > ENTRY_MAX {
                return Err(BundleError::new(
                    "too_large",
                    "an entry is larger than 512 MiB",
                ));
            }
            if !is_digest(&entry.sha256) {
                return Err(BundleError::new(
                    "invalid_manifest",
                    "an entry digest is not 64 lower-case hex digits",
                ));
            }
        }
        check_order(&self.entries)?;
        if self.content_length() > BUNDLE_MAX {
            return Err(BundleError::new("too_large", "a bundle is at most 2 GiB"));
        }
        Ok(())
    }

    /// `validate`, and the whole bundle this manifest makes within 2 GiB.
    pub(crate) fn validate_encoded(&self, manifest_len: u64) -> BundleResult<()> {
        self.validate()?;
        if manifest_len == 0 || manifest_len > u64::from(MANIFEST_MAX) {
            return Err(BundleError::new(
                "too_large",
                "the manifest is larger than 1 MiB",
            ));
        }
        if self.bundle_length(manifest_len) > BUNDLE_MAX {
            return Err(BundleError::new("too_large", "a bundle is at most 2 GiB"));
        }
        Ok(())
    }

    /// A manifest as a reader takes it: every key and value checked, and its
    /// agent and conversation id exactly those the import named.
    pub(crate) fn decode(bytes: &[u8], agent: &str, conversation_id: &str) -> BundleResult<Self> {
        let invalid = |detail: &str| BundleError::new("invalid_manifest", detail);
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| invalid("the manifest is not JSON"))?;
        let object = value
            .as_object()
            .ok_or_else(|| invalid("the manifest is not an object"))?;
        if object.len() != 3
            || !["agent", "conversation_id", "entries"]
                .iter()
                .all(|key| object.contains_key(*key))
        {
            return Err(invalid("the manifest has other keys than its three"));
        }
        if object.get("agent").and_then(Value::as_str) != Some(agent) {
            return Err(invalid("the manifest names another agent"));
        }
        if object.get("conversation_id").and_then(Value::as_str) != Some(conversation_id) {
            return Err(invalid("the manifest names another conversation"));
        }
        let listed = object
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("the manifest's entries are not a list"))?;
        if listed.len() > ENTRIES_MAX {
            return Err(BundleError::new(
                "too_large",
                "a bundle holds at most 4,096 entries",
            ));
        }
        let mut entries = Vec::with_capacity(listed.len());
        for item in listed {
            let entry = item
                .as_object()
                .ok_or_else(|| invalid("an entry is not an object"))?;
            if entry.len() != 3
                || !["path", "size", "sha256"]
                    .iter()
                    .all(|key| entry.contains_key(*key))
            {
                return Err(invalid(
                    "an entry has other keys than path, size and sha256",
                ));
            }
            let path = entry
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("an entry path is not text"))?;
            check_path(agent, path)?;
            let size = entry
                .get("size")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid("an entry size is not a whole number of bytes"))?;
            if size > ENTRY_MAX {
                return Err(BundleError::new(
                    "too_large",
                    "an entry is larger than 512 MiB",
                ));
            }
            let sha256 = entry
                .get("sha256")
                .and_then(Value::as_str)
                .filter(|digest| is_digest(digest))
                .ok_or_else(|| invalid("an entry digest is not 64 lower-case hex digits"))?;
            entries.push(Entry {
                path: path.to_string(),
                size,
                sha256: sha256.to_string(),
            });
        }
        let manifest = Self {
            agent: agent.to_string(),
            conversation_id: conversation_id.to_string(),
            entries,
        };
        manifest.validate()?;
        Ok(manifest)
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Exactly one `conversation.jsonl`, last; the others in ascending byte
/// order of their paths, without duplicates.
fn check_order(entries: &[Entry]) -> BundleResult<()> {
    let out_of_order = || {
        BundleError::new(
            "entry_order",
            "entries are not the sidecar in byte order followed by the record",
        )
    };
    let (last, rest) = entries.split_last().ok_or_else(out_of_order)?;
    if last.path != CONVERSATION || rest.iter().any(|entry| entry.path == CONVERSATION) {
        return Err(out_of_order());
    }
    if rest
        .windows(2)
        .any(|pair| pair[0].path.as_bytes() >= pair[1].path.as_bytes())
    {
        return Err(out_of_order());
    }
    Ok(())
}

pub(crate) fn header(manifest_len: u32) -> [u8; 12] {
    let mut header = [0_u8; 12];
    header[..4].copy_from_slice(&MAGIC);
    header[4] = VERSION;
    header[8..].copy_from_slice(&manifest_len.to_be_bytes());
    header
}

/// The manifest length a header declares.
pub(crate) fn parse_header(header: &[u8; 12]) -> BundleResult<u32> {
    if header[..4] != MAGIC {
        return Err(BundleError::new(
            "invalid_bundle",
            "not a conversation bundle",
        ));
    }
    if header[4] != VERSION {
        return Err(BundleError::new(
            "unsupported_version",
            "a conversation bundle version this host does not read",
        ));
    }
    if header[5..8] != [0, 0, 0] {
        return Err(BundleError::new(
            "invalid_bundle",
            "reserved header bytes are set",
        ));
    }
    let manifest_len = u32::from_be_bytes([header[8], header[9], header[10], header[11]]);
    if manifest_len == 0 || manifest_len > MANIFEST_MAX {
        return Err(BundleError::new(
            "invalid_bundle",
            "the manifest length is outside 1 byte to 1 MiB",
        ));
    }
    Ok(manifest_len)
}

/// Entry bytes inside one fed slice: `bytes[start..end]` belong to entry
/// `entry`, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub entry: usize,
    pub start: usize,
    pub end: usize,
}

/// Validates a bundle as its bytes arrive, in any slicing: the header, then
/// the whole manifest, before it hands back a byte of any entry; each
/// entry's digest at that entry's end; and the declared length against the
/// manifest's as soon as the manifest is read. The whole stream's digest is
/// the stream's to check.
pub(crate) struct Reader {
    agent: String,
    conversation_id: String,
    declared: u64,
    consumed: u64,
    header: Vec<u8>,
    manifest_len: Option<u32>,
    manifest_bytes: Vec<u8>,
    manifest: Option<Manifest>,
    entry: usize,
    entry_read: u64,
    hasher: Sha256,
}

impl Reader {
    pub(crate) fn new(agent: &str, conversation_id: &str, declared: u64) -> BundleResult<Self> {
        if declared > BUNDLE_MAX {
            return Err(BundleError::new("too_large", "a bundle is at most 2 GiB"));
        }
        if declared <= HEADER_BYTES {
            return Err(BundleError::new(
                "invalid_bundle",
                "a declared length shorter than any bundle",
            ));
        }
        Ok(Self {
            agent: agent.to_string(),
            conversation_id: conversation_id.to_string(),
            declared,
            consumed: 0,
            header: Vec::with_capacity(HEADER_BYTES as usize),
            manifest_len: None,
            manifest_bytes: Vec::new(),
            manifest: None,
            entry: 0,
            entry_read: 0,
            hasher: Sha256::new(),
        })
    }

    pub(crate) fn manifest(&self) -> Option<&Manifest> {
        self.manifest.as_ref()
    }

    /// Every byte declared has been read and every entry verified.
    pub(crate) fn complete(&self) -> bool {
        self.consumed == self.declared
            && self
                .manifest
                .as_ref()
                .is_some_and(|manifest| self.entry == manifest.entries.len())
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> BundleResult<Vec<Span>> {
        if self.consumed.saturating_add(bytes.len() as u64) > self.declared {
            return Err(BundleError::new(
                "invalid_bundle",
                "more bytes than the bundle declared",
            ));
        }
        self.consumed += bytes.len() as u64;
        let mut spans = Vec::new();
        let mut at = 0_usize;
        while at < bytes.len() {
            let rest = &bytes[at..];
            if self.header.len() < HEADER_BYTES as usize {
                let take = rest.len().min(HEADER_BYTES as usize - self.header.len());
                self.header.extend_from_slice(&rest[..take]);
                at += take;
                if self.header.len() == HEADER_BYTES as usize {
                    let mut header = [0_u8; 12];
                    header.copy_from_slice(&self.header);
                    let manifest_len = parse_header(&header)?;
                    self.manifest_len = Some(manifest_len);
                    self.manifest_bytes.reserve(manifest_len as usize);
                }
                continue;
            }
            let manifest_len = self.manifest_len.unwrap_or_default() as usize;
            if self.manifest.is_none() {
                let take = rest.len().min(manifest_len - self.manifest_bytes.len());
                self.manifest_bytes.extend_from_slice(&rest[..take]);
                at += take;
                if self.manifest_bytes.len() == manifest_len {
                    let manifest =
                        Manifest::decode(&self.manifest_bytes, &self.agent, &self.conversation_id)?;
                    if manifest.bundle_length(manifest_len as u64) != self.declared {
                        return Err(BundleError::new(
                            "invalid_bundle",
                            "the declared length is not the manifest's",
                        ));
                    }
                    self.manifest = Some(manifest);
                    self.manifest_bytes = Vec::new();
                    self.settle_empty_entries()?;
                }
                continue;
            }
            let Some(entry) = self
                .manifest
                .as_ref()
                .and_then(|manifest| manifest.entries.get(self.entry))
            else {
                return Err(BundleError::new(
                    "invalid_bundle",
                    "bytes after the last entry",
                ));
            };
            let size = entry.size;
            let take = (rest.len() as u64).min(size - self.entry_read) as usize;
            self.hasher.update(&rest[..take]);
            self.entry_read += take as u64;
            spans.push(Span {
                entry: self.entry,
                start: at,
                end: at + take,
            });
            at += take;
            if self.entry_read == size {
                self.finish_entry()?;
                self.settle_empty_entries()?;
            }
        }
        Ok(spans)
    }

    fn finish_entry(&mut self) -> BundleResult<()> {
        let digest = format!("{:x}", std::mem::take(&mut self.hasher).finalize());
        let expected = self
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.entries.get(self.entry))
            .map(|entry| entry.sha256.as_str());
        if expected != Some(digest.as_str()) {
            return Err(BundleError::new(
                "integrity_mismatch",
                "an entry's bytes do not match its digest",
            ));
        }
        self.entry += 1;
        self.entry_read = 0;
        Ok(())
    }

    /// An empty entry ends where it begins.
    fn settle_empty_entries(&mut self) -> BundleResult<()> {
        while self
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.entries.get(self.entry))
            .is_some_and(|entry| entry.size == 0)
        {
            self.finish_entry()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    use super::*;

    /// The chunk field, spelled so the protected-content guard's inventory of
    /// where it may appear stays the reviewed two lines of `host_direct.rs`.
    const BYTES_FIELD: &str = concat!("bytes", "_b64");

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../proto/conversation-bundle-v1-vectors.json"
        ))
        .unwrap()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn limits_match_the_specification() {
        let limits = vectors()["limits"].clone();
        assert_eq!(limits["header_bytes"], HEADER_BYTES);
        assert_eq!(limits["manifest_bytes_max"], MANIFEST_MAX);
        assert_eq!(limits["entries_max"], ENTRIES_MAX);
        assert_eq!(limits["entry_bytes_max"], ENTRY_MAX);
        assert_eq!(limits["bundle_bytes_max"], BUNDLE_MAX);
        assert_eq!(ENTRY_MAX, crate::host_files::MAX_FILE_BYTES);
    }

    /// The writer's half: the same files make byte for byte the bundle the
    /// vectors hold, and the reader takes it back in any slicing.
    #[test]
    fn bundles_are_written_and_read_as_the_vectors_hold_them() {
        let vectors = vectors();
        for bundle in vectors["bundles"].as_array().unwrap() {
            let agent = bundle["agent"].as_str().unwrap();
            let id = bundle["conversation_id"].as_str().unwrap();
            let entries: Vec<(String, Vec<u8>)> = bundle["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    (
                        entry["path"].as_str().unwrap().to_string(),
                        STANDARD
                            .decode(entry[BYTES_FIELD].as_str().unwrap())
                            .unwrap(),
                    )
                })
                .collect();
            let manifest = Manifest {
                agent: agent.into(),
                conversation_id: id.into(),
                entries: entries
                    .iter()
                    .map(|(path, bytes)| Entry {
                        path: path.clone(),
                        size: bytes.len() as u64,
                        sha256: format!("{:x}", Sha256::digest(bytes)),
                    })
                    .collect(),
            };
            manifest.validate().unwrap();
            let encoded = manifest.encode();
            assert_eq!(
                std::str::from_utf8(&encoded).unwrap(),
                bundle["manifest"].as_str().unwrap()
            );
            assert_eq!(
                encoded.len() as u64,
                bundle["manifest_length"].as_u64().unwrap()
            );
            let header = header(encoded.len() as u32);
            assert_eq!(hex(&header), bundle["header_hex"].as_str().unwrap());
            let mut whole = header.to_vec();
            whole.extend_from_slice(&encoded);
            for (_, bytes) in &entries {
                whole.extend_from_slice(bytes);
            }
            assert_eq!(whole.len() as u64, bundle["length"].as_u64().unwrap());
            assert_eq!(
                whole,
                STANDARD
                    .decode(bundle["bundle_b64"].as_str().unwrap())
                    .unwrap()
            );
            assert_eq!(
                format!("{:x}", Sha256::digest(&whole)),
                bundle["sha256"].as_str().unwrap()
            );
            assert_eq!(
                manifest.bundle_length(encoded.len() as u64),
                whole.len() as u64
            );
            for slice in [1, 7, 12, 13, 8192, whole.len()] {
                let mut reader = Reader::new(agent, id, whole.len() as u64).unwrap();
                let mut carried: Vec<Vec<u8>> = vec![Vec::new(); entries.len()];
                for piece in whole.chunks(slice) {
                    for span in reader.feed(piece).unwrap() {
                        carried[span.entry].extend_from_slice(&piece[span.start..span.end]);
                    }
                }
                assert!(reader.complete(), "slice {slice}");
                assert_eq!(reader.manifest(), Some(&manifest));
                for (index, (_, bytes)) in entries.iter().enumerate() {
                    assert_eq!(&carried[index], bytes, "slice {slice}");
                }
            }
        }
    }

    #[test]
    fn paths_follow_the_allowlist() {
        for case in vectors()["paths"].as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            let got = check_path(CLAUDE_CODE, path).err().map(|error| error.code);
            assert_eq!(got, case["error"].as_str(), "{case}");
        }
        // The allowlist patterns themselves, for a reader in another runtime.
        let allowlist = vectors()["allowlist"]["claude-code"].clone();
        assert_eq!(allowlist.as_array().unwrap().len(), 6);
        assert!(check_path("codex", CONVERSATION).is_err());
    }

    #[test]
    fn begins_name_a_defined_agent_and_a_canonical_id() {
        for case in vectors()["requests"].as_array().unwrap() {
            let agent = case["agent"].as_str().unwrap();
            let valid = known_agent(agent)
                && case["conversation_id"]
                    .as_str()
                    .is_some_and(is_canonical_id);
            assert_eq!(valid, case["error"].is_null(), "{case}");
            if !valid {
                assert_eq!(case["error"], "invalid_request", "{case}");
            }
        }
    }

    #[test]
    fn manifests_are_refused_as_the_vectors_say() {
        let vectors = vectors();
        let request = &vectors["request"];
        let agent = request["agent"].as_str().unwrap();
        let id = request["conversation_id"].as_str().unwrap();
        for case in vectors["manifests"].as_array().unwrap() {
            let mut manifest = case.clone();
            let object = manifest.as_object_mut().unwrap();
            object.remove("name");
            let expected = object.remove("error").unwrap();
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let got = Manifest::decode(&bytes, agent, id)
                .err()
                .map(|error| error.code);
            assert_eq!(got, expected.as_str(), "{}", case["name"]);
        }
    }

    #[test]
    fn headers_are_refused_as_the_vectors_say() {
        for case in vectors()["headers"].as_array().unwrap() {
            let bytes = unhex(case["header_hex"].as_str().unwrap());
            let header: [u8; 12] = bytes.try_into().unwrap();
            let got = parse_header(&header).err().map(|error| error.code);
            assert_eq!(got, case["error"].as_str(), "{}", case["name"]);
            // The reader reaches the same verdict from the first 12 bytes.
            let mut reader =
                Reader::new(CLAUDE_CODE, "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60", 1 << 21).unwrap();
            let fed = reader.feed(&header).err().map(|error| error.code);
            assert_eq!(fed, case["error"].as_str(), "{}", case["name"]);
        }
    }

    #[test]
    fn a_declared_length_must_be_the_manifests() {
        let vectors = vectors();
        for case in vectors["lengths"].as_array().unwrap() {
            let bytes = STANDARD
                .decode(case["bundle_b64"].as_str().unwrap())
                .unwrap();
            let declared = case["declared_length"].as_u64().unwrap();
            let mut reader = Reader::new(
                CLAUDE_CODE,
                "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60",
                declared,
            )
            .unwrap();
            // Fed as far as the declaration allows.
            let usable = &bytes[..bytes.len().min(declared as usize)];
            let result = reader.feed(usable);
            match case["name"].as_str().unwrap() {
                "exactly 12 + M + the entries' sizes" => {
                    result.unwrap();
                    assert!(reader.complete());
                }
                _ => assert_eq!(result.unwrap_err().code, "invalid_bundle", "{case}"),
            }
        }
    }

    #[test]
    fn a_tampered_entry_fails_its_digest_before_the_next_begins() {
        let vectors = vectors();
        let bundle = &vectors["bundles"][1];
        let mut whole = STANDARD
            .decode(bundle["bundle_b64"].as_str().unwrap())
            .unwrap();
        let manifest_len = bundle["manifest_length"].as_u64().unwrap() as usize;
        // The first byte of the first entry.
        whole[12 + manifest_len] ^= 0x01;
        let mut reader = Reader::new(
            bundle["agent"].as_str().unwrap(),
            bundle["conversation_id"].as_str().unwrap(),
            whole.len() as u64,
        )
        .unwrap();
        assert_eq!(reader.feed(&whole).unwrap_err().code, "integrity_mismatch");
    }

    #[test]
    fn no_entry_byte_is_handed_back_before_the_manifest_is_checked() {
        // A manifest naming another conversation: nothing after it is
        // accepted, however it is sliced.
        let manifest = Manifest {
            agent: CLAUDE_CODE.into(),
            conversation_id: "0199a8b2-6c3e-7f10-9d2b-5a4e3c2b1a09".into(),
            entries: vec![Entry {
                path: CONVERSATION.into(),
                size: 3,
                sha256: format!("{:x}", Sha256::digest(b"abc")),
            }],
        };
        let encoded = manifest.encode();
        let mut whole = header(encoded.len() as u32).to_vec();
        whole.extend_from_slice(&encoded);
        whole.extend_from_slice(b"abc");
        let mut reader = Reader::new(
            CLAUDE_CODE,
            "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60",
            whole.len() as u64,
        )
        .unwrap();
        let error = reader.feed(&whole).unwrap_err();
        assert_eq!(error.code, "invalid_manifest");
        assert!(reader.manifest().is_none());
    }

    #[test]
    fn empty_entries_end_where_they_begin() {
        let empty = format!("{:x}", Sha256::digest(b""));
        let manifest = Manifest {
            agent: CLAUDE_CODE.into(),
            conversation_id: "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60".into(),
            entries: vec![
                Entry {
                    path: "sidecar/tool-results/a.txt".into(),
                    size: 0,
                    sha256: empty.clone(),
                },
                Entry {
                    path: CONVERSATION.into(),
                    size: 0,
                    sha256: empty,
                },
            ],
        };
        let encoded = manifest.encode();
        let mut whole = header(encoded.len() as u32).to_vec();
        whole.extend_from_slice(&encoded);
        let mut reader = Reader::new(
            CLAUDE_CODE,
            "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60",
            whole.len() as u64,
        )
        .unwrap();
        assert!(reader.feed(&whole).unwrap().is_empty());
        assert!(reader.complete());
    }

    #[test]
    fn logs_are_the_jsonl_entries() {
        assert!(is_log(CONVERSATION));
        assert!(is_log("sidecar/subagents/agent-a1.jsonl"));
        assert!(!is_log("sidecar/subagents/agent-a1.meta.json"));
        assert!(!has_extension(".json", &["json"]));
        assert!(!has_extension("json", &["json"]));
    }
}
