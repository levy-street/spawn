//! Multi-anchor chain validation — the host side of the device-mesh admission
//! rule (docs/TRUST_DEVICE_MESH.md §3).
//!
//! A device reaches a host by carrying a **chain** of account-scoped
//! endorsements ([`crate::acct_endorsement`]) from one of the host's **anchors**
//! down to its own key:
//!
//! ```text
//!   pk_a0  ──endorse──▶  pk_a1  ──endorse──▶  …  ──endorse──▶  pk_d
//!   (∈ A(h))                                                   (connecting key)
//! ```
//!
//! This module is the validator the host runs on that chain. It enforces the
//! admission rule's clauses **2–4**:
//!   2. a valid endorsement chain from some anchor `a0 ∈ A(h)` to `pk_d`;
//!   3. no key on the chain (including `pk_d`) is revoked;
//!   4. the chain is a **simple path** (no key twice — mutual endorsements form
//!      2-cycles and trust must not launder through a loop) within a length bound
//!      (a validation-DoS cap).
//!
//! Clause **1** — proof that the connecting party actually holds `sk_d` — is the
//! connect path's job (the signed-RTC handshake, P5) and is deliberately *not*
//! re-done here: [`validate_chain`] takes the key whose possession was already
//! proven and asks only "does *this* key chain to an anchor, unrevoked?". The two
//! together are the full admission rule.
//!
//! Not yet wired into the connect path: today a host admits a browser only if its
//! key is *directly* pinned (single hop). This validator is what will let a host
//! admit a key reachable through a carried chain instead; that wiring is the next
//! step, held for review.

use std::collections::HashSet;

use ed25519_dalek::{Signature, VerifyingKey};
use thiserror::Error;

use crate::acct_endorsement::{
    verify_endorsement, AcctEndorsementError, AcctEndorsementTranscript, PUBLIC_KEY_BYTES,
    UUID_BYTES,
};

/// Default cap on chain length (number of endorsement edges). In the healed
/// root/star steady state every device is one hop from the root; pre-heal
/// transient chains are short. Generous enough never to reject a real chain,
/// small enough to bound per-connect verification work.
pub const DEFAULT_MAX_CHAIN_EDGES: usize = 8;

/// One endorsement edge in a presented chain: the signed statement plus its
/// signature. `transcript.endorser_public_key` endorses `transcript.endorsed_public_key`.
#[derive(Debug, Clone)]
pub struct ChainEdge {
    pub transcript: AcctEndorsementTranscript,
    pub signature: Signature,
}

/// Account deny-list. The host subtracts these keys from acceptance; it is
/// delivered by the server on connect and is **add-only** for the account owner,
/// **subtract-only** in effect (docs §3). Populated by the revocation channel
/// (a later stage); defined here because chain validation is its only consumer.
#[derive(Debug, Default, Clone)]
pub struct RevocationSet {
    keys: HashSet<[u8; PUBLIC_KEY_BYTES]>,
}

impl RevocationSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_keys(keys: impl IntoIterator<Item = [u8; PUBLIC_KEY_BYTES]>) -> Self {
        Self {
            keys: keys.into_iter().collect(),
        }
    }

    /// Add a key to the deny-list. Returns true if it was newly inserted.
    pub fn insert(&mut self, key: [u8; PUBLIC_KEY_BYTES]) -> bool {
        self.keys.insert(key)
    }

    pub fn contains(&self, key: &[u8; PUBLIC_KEY_BYTES]) -> bool {
        self.keys.contains(key)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ChainError {
    #[error("chain has {got} edges, exceeding the maximum of {max}")]
    TooLong { max: usize, got: usize },
    #[error("a zero-length chain requires the connecting key to be an anchor")]
    NotAnchored,
    #[error("the first endorser is not one of the host's anchors")]
    FirstEndorserNotAnchor,
    #[error("edge {index} does not continue the chain (its endorser is not the prior link)")]
    BrokenLink { index: usize },
    #[error("edge {index} carries a signature that does not verify")]
    InvalidEdge { index: usize },
    #[error("edge {index} is scoped to a different account")]
    WrongAccount { index: usize },
    #[error("edge {index} names a malformed public key")]
    MalformedKey { index: usize },
    #[error("the chain does not terminate at the connecting key")]
    TerminalMismatch,
    #[error("the chain revisits a key — trust may not launder through a cycle")]
    Cycle,
    #[error("a key on the chain has been revoked")]
    Revoked,
}

/// Validate that `connecting_key` (whose possession was already proven by the
/// connect path) has a valid, unrevoked, simple endorsement chain to one of the
/// host's `anchors`, for `account_id`.
///
/// `edges` is the chain in order from the anchor end to the connecting key:
/// `edges[0].endorser ∈ anchors`, `edges[i].endorser == edges[i-1].endorsed`,
/// and `edges.last().endorsed == connecting_key`. An empty `edges` is a
/// length-0 chain: `connecting_key` must itself be an anchor (the possessing
/// device's own connection).
pub fn validate_chain(
    account_id: &[u8; UUID_BYTES],
    anchors: &[VerifyingKey],
    revoked: &RevocationSet,
    connecting_key: &VerifyingKey,
    edges: &[ChainEdge],
    max_edges: usize,
) -> Result<(), ChainError> {
    if edges.len() > max_edges {
        return Err(ChainError::TooLong {
            max: max_edges,
            got: edges.len(),
        });
    }

    // Clause 2: verify each edge's signature and that trust flows anchor→…→d.
    // Edge 0's endorser must be an anchor; each later edge's endorser must be the
    // previous edge's endorsed key. verify_endorsement enforces "endorser is in
    // the trusted set AND the signature verifies" in one step, so passing the
    // anchors for edge 0 and the single prior link for edge i realizes both the
    // anchor check and the contiguity check as signature-backed facts.
    for (index, edge) in edges.iter().enumerate() {
        if &edge.transcript.account_id != account_id {
            return Err(ChainError::WrongAccount { index });
        }
        let outcome = if index == 0 {
            verify_endorsement(&edge.transcript, &edge.signature, anchors)
        } else {
            let expected_endorser =
                VerifyingKey::from_bytes(&edges[index - 1].transcript.endorsed_public_key)
                    .map_err(|_| ChainError::MalformedKey { index: index - 1 })?;
            verify_endorsement(
                &edge.transcript,
                &edge.signature,
                std::slice::from_ref(&expected_endorser),
            )
        };
        outcome.map_err(|err| match (index, err) {
            (0, AcctEndorsementError::UntrustedEndorser) => ChainError::FirstEndorserNotAnchor,
            (_, AcctEndorsementError::UntrustedEndorser) => ChainError::BrokenLink { index },
            _ => ChainError::InvalidEdge { index },
        })?;
    }

    // The chain must actually deliver the key that proved possession.
    match edges.last() {
        None => {
            if !anchors
                .iter()
                .any(|anchor| anchor.to_bytes() == connecting_key.to_bytes())
            {
                return Err(ChainError::NotAnchored);
            }
        }
        Some(last) => {
            if last.transcript.endorsed_public_key != connecting_key.to_bytes() {
                return Err(ChainError::TerminalMismatch);
            }
        }
    }

    // The ordered list of keys on the path: the anchor end, then each endorsed
    // key. For a length-0 chain that is just the connecting key.
    let mut path: Vec<[u8; PUBLIC_KEY_BYTES]> = Vec::with_capacity(edges.len() + 1);
    match edges.first() {
        None => path.push(connecting_key.to_bytes()),
        Some(first) => {
            path.push(first.transcript.endorser_public_key);
            for edge in edges {
                path.push(edge.transcript.endorsed_public_key);
            }
        }
    }

    // Clause 4 (simple path): no key may appear twice. Mutual endorsements create
    // 2-cycles; a valid chain never needs to revisit a key, so requiring
    // distinctness blocks laundering trust through a loop without rejecting any
    // legitimate path.
    let mut seen: HashSet<[u8; PUBLIC_KEY_BYTES]> = HashSet::with_capacity(path.len());
    for key in &path {
        if !seen.insert(*key) {
            return Err(ChainError::Cycle);
        }
    }

    // Clause 3: no key anywhere on the path may be revoked.
    if path.iter().any(|key| revoked.contains(key)) {
        return Err(ChainError::Revoked);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acct_endorsement::sign_transcript;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use ed25519_dalek::SigningKey;
    use uuid::Uuid;

    const USER: &str = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const OTHER_USER: &str = "00000000-0000-4000-8000-000000000000";
    // A pool of canonical device UUIDs for the endorsed device id on each edge.
    const DEVICES: [&str; 4] = [
        "11111111-2222-4333-8444-555555555551",
        "11111111-2222-4333-8444-555555555552",
        "11111111-2222-4333-8444-555555555553",
        "11111111-2222-4333-8444-555555555554",
    ];

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn wire(key: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
    }

    fn account_bytes(user: &str) -> [u8; UUID_BYTES] {
        *Uuid::parse_str(user).unwrap().as_bytes()
    }

    /// An edge `endorser → endorsed`, signed by the endorser, scoped to `user`.
    fn edge(user: &str, endorser: &SigningKey, endorsed: &SigningKey, device: &str) -> ChainEdge {
        let transcript =
            AcctEndorsementTranscript::from_wire(user, &wire(endorser), &wire(endorsed), device)
                .expect("valid transcript");
        let signature = sign_transcript(endorser, &transcript);
        ChainEdge {
            transcript,
            signature,
        }
    }

    #[test]
    fn a_device_that_is_an_anchor_connects_with_no_chain() {
        let device = key(1);
        validate_chain(
            &account_bytes(USER),
            &[device.verifying_key()],
            &RevocationSet::new(),
            &device.verifying_key(),
            &[],
            DEFAULT_MAX_CHAIN_EDGES,
        )
        .expect("the possessing device is admitted directly");
    }

    #[test]
    fn a_non_anchor_with_no_chain_is_refused() {
        let (anchor, stranger) = (key(1), key(2));
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[anchor.verifying_key()],
                &RevocationSet::new(),
                &stranger.verifying_key(),
                &[],
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::NotAnchored)
        );
    }

    #[test]
    fn a_single_hop_endorsement_from_an_anchor_is_admitted() {
        let (anchor, device) = (key(1), key(2));
        let edges = [edge(USER, &anchor, &device, DEVICES[0])];
        validate_chain(
            &account_bytes(USER),
            &[anchor.verifying_key()],
            &RevocationSet::new(),
            &device.verifying_key(),
            &edges,
            DEFAULT_MAX_CHAIN_EDGES,
        )
        .expect("anchor-endorsed device is admitted");
    }

    #[test]
    fn a_multi_hop_chain_to_an_anchor_is_admitted() {
        // anchor A → B → C → D, host anchors on A, connecting key is D. This is
        // the property single-hop pinning cannot express and the whole point of
        // account-scoped carried chains.
        let (a, b, c, d) = (key(1), key(2), key(3), key(4));
        let edges = [
            edge(USER, &a, &b, DEVICES[0]),
            edge(USER, &b, &c, DEVICES[1]),
            edge(USER, &c, &d, DEVICES[2]),
        ];
        validate_chain(
            &account_bytes(USER),
            &[a.verifying_key()],
            &RevocationSet::new(),
            &d.verifying_key(),
            &edges,
            DEFAULT_MAX_CHAIN_EDGES,
        )
        .expect("a three-hop chain to the anchor is admitted");
    }

    #[test]
    fn any_anchor_in_the_set_can_root_the_chain() {
        // Trust is a set of anchors (possessing device and/or root): a chain may
        // start at any of them.
        let (a, root, device) = (key(1), key(7), key(2));
        let edges = [edge(USER, &root, &device, DEVICES[0])];
        validate_chain(
            &account_bytes(USER),
            &[a.verifying_key(), root.verifying_key()],
            &RevocationSet::new(),
            &device.verifying_key(),
            &edges,
            DEFAULT_MAX_CHAIN_EDGES,
        )
        .expect("a chain rooted at the second anchor is admitted");
    }

    #[test]
    fn a_chain_whose_root_is_not_an_anchor_is_refused() {
        let (anchor, stranger, device) = (key(1), key(9), key(2));
        let edges = [edge(USER, &stranger, &device, DEVICES[0])];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[anchor.verifying_key()],
                &RevocationSet::new(),
                &device.verifying_key(),
                &edges,
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::FirstEndorserNotAnchor)
        );
    }

    #[test]
    fn a_broken_link_is_refused() {
        // anchor A → B, then C → D (C never endorsed by the chain): the second
        // edge does not continue the first. A server splicing two unrelated real
        // endorsements together must be caught here.
        let (a, b, c, d) = (key(1), key(2), key(3), key(4));
        let edges = [
            edge(USER, &a, &b, DEVICES[0]),
            edge(USER, &c, &d, DEVICES[1]),
        ];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[a.verifying_key()],
                &RevocationSet::new(),
                &d.verifying_key(),
                &edges,
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::BrokenLink { index: 1 })
        );
    }

    #[test]
    fn a_chain_not_ending_at_the_connecting_key_is_refused() {
        // A→B→C is valid, but the party connecting presents key D. The chain
        // proves nothing about D.
        let (a, b, c, d) = (key(1), key(2), key(3), key(4));
        let edges = [
            edge(USER, &a, &b, DEVICES[0]),
            edge(USER, &b, &c, DEVICES[1]),
        ];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[a.verifying_key()],
                &RevocationSet::new(),
                &d.verifying_key(),
                &edges,
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::TerminalMismatch)
        );
    }

    #[test]
    fn a_forged_edge_signature_is_refused() {
        let (a, b, impostor) = (key(1), key(2), key(5));
        // Build a real A→B transcript but sign it with the wrong key.
        let transcript =
            AcctEndorsementTranscript::from_wire(USER, &wire(&a), &wire(&b), DEVICES[0]).unwrap();
        let signature = sign_transcript(&impostor, &transcript);
        let edges = [ChainEdge {
            transcript,
            signature,
        }];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[a.verifying_key()],
                &RevocationSet::new(),
                &b.verifying_key(),
                &edges,
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::InvalidEdge { index: 0 })
        );
    }

    #[test]
    fn an_edge_scoped_to_another_account_is_refused() {
        let (a, b) = (key(1), key(2));
        let edges = [edge(OTHER_USER, &a, &b, DEVICES[0])];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[a.verifying_key()],
                &RevocationSet::new(),
                &b.verifying_key(),
                &edges,
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::WrongAccount { index: 0 })
        );
    }

    #[test]
    fn a_chain_that_revisits_a_key_is_refused() {
        // A→B→C→B: every edge is individually valid and contiguous, but B appears
        // twice. Mutual endorsements make such loops constructible; the simple-path
        // rule refuses to let trust launder through them.
        let (a, b, c) = (key(1), key(2), key(3));
        let edges = [
            edge(USER, &a, &b, DEVICES[0]),
            edge(USER, &b, &c, DEVICES[1]),
            edge(USER, &c, &b, DEVICES[2]),
        ];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[a.verifying_key()],
                &RevocationSet::new(),
                &b.verifying_key(),
                &edges,
                DEFAULT_MAX_CHAIN_EDGES,
            ),
            Err(ChainError::Cycle)
        );
    }

    #[test]
    fn a_revoked_key_anywhere_on_the_chain_is_refused() {
        let (a, b, c, d) = (key(1), key(2), key(3), key(4));
        let edges = [
            edge(USER, &a, &b, DEVICES[0]),
            edge(USER, &b, &c, DEVICES[1]),
            edge(USER, &c, &d, DEVICES[2]),
        ];
        let account = account_bytes(USER);
        let anchors = [a.verifying_key()];
        // Revoking the anchor, an intermediate, or the terminal each blocks it.
        for revoked_key in [&a, &c, &d] {
            let revoked = RevocationSet::from_keys([revoked_key.verifying_key().to_bytes()]);
            assert_eq!(
                validate_chain(
                    &account,
                    &anchors,
                    &revoked,
                    &d.verifying_key(),
                    &edges,
                    DEFAULT_MAX_CHAIN_EDGES,
                ),
                Err(ChainError::Revoked),
                "revoking {:?} must block the chain",
                revoked_key.verifying_key().to_bytes()[0]
            );
        }
    }

    #[test]
    fn a_chain_longer_than_the_bound_is_refused() {
        let (a, b, c) = (key(1), key(2), key(3));
        let edges = [
            edge(USER, &a, &b, DEVICES[0]),
            edge(USER, &b, &c, DEVICES[1]),
        ];
        assert_eq!(
            validate_chain(
                &account_bytes(USER),
                &[a.verifying_key()],
                &RevocationSet::new(),
                &c.verifying_key(),
                &edges,
                1,
            ),
            Err(ChainError::TooLong { max: 1, got: 2 })
        );
    }

    #[test]
    fn revocation_set_is_add_only_and_deduplicates() {
        let mut revoked = RevocationSet::new();
        let k = key(2).verifying_key().to_bytes();
        assert!(revoked.insert(k));
        assert!(!revoked.insert(k));
        assert!(revoked.contains(&k));
        assert_eq!(revoked.len(), 1);
    }
}
