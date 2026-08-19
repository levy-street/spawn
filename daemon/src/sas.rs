//! Committed-ephemeral Short Authentication String (SAS) for host↔browser and
//! browser↔browser pairing — the number a human compares across two screens.
//!
//! This is the construction docs/TRUST_DEVICE_MESH.md Appendix A requires: a
//! 6-digit code a substituting/grinding server **cannot** forge. It is Bluetooth
//! Secure Simple Pairing "Numeric Comparison" adapted to our relay-mediated
//! flow. Each side contributes a fresh 32-byte nonce; the committer hashes its
//! nonce before the peer reveals theirs, so neither the peer nor a relaying MITM
//! can adapt its contribution after seeing the target — the two displayed SAS
//! values then collide only with probability 2^-20 ≈ 1e-6 per one-shot ceremony.
//!
//! Contrast a bare code derived from the long-lived host key alone (the earlier
//! grindable approach): a server grinds a matching key in ~1e6 work. THIS is the
//! sound security check.
//!
//! The web side must compute these identically (see web/src/lib/sas.ts); the
//! shared test vectors below are asserted in both and must never drift.

use sha2::{Digest, Sha256};

const COMMIT_DOMAIN: &[u8] = b"SPAWN-SAS-COMMIT-V1";
const SAS_DOMAIN: &[u8] = b"SPAWN-SAS-V1";

/// Public-key / nonce width. Ed25519 public keys and our SAS nonces are 32 bytes.
pub const FIELD_BYTES: usize = 32;

/// `Cd = SHA256(COMMIT_DOMAIN ‖ host_key ‖ host_nonce)` — the committer hides its
/// nonce behind this before the peer reveals theirs. Binding the host key in the
/// commitment pins the key the committer claims (defense in depth).
pub fn commit(host_key: &[u8; FIELD_BYTES], host_nonce: &[u8; FIELD_BYTES]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(COMMIT_DOMAIN);
    h.update(host_key);
    h.update(host_nonce);
    h.finalize().into()
}

/// Constant-time check that `commitment` opens to `(host_key, host_nonce)`.
pub fn verify_commit(
    commitment: &[u8; 32],
    host_key: &[u8; FIELD_BYTES],
    host_nonce: &[u8; FIELD_BYTES],
) -> bool {
    // Both operands are public one-shot values (the nonce is revealed in the
    // clear this same round), so a byte compare leaks nothing sensitive; we
    // still fold to a single bool without early exit.
    let expected = commit(host_key, host_nonce);
    expected
        .iter()
        .zip(commitment.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// The 6-digit SAS both endpoints display, computed from the keys and nonces
/// **as each endpoint sees them**. Formatted `"NNN NNN"`. A key substituted by
/// the relay makes the two sides' inputs differ, so their SAS differ.
pub fn sas(
    host_key: &[u8; FIELD_BYTES],
    browser_key: &[u8; FIELD_BYTES],
    host_nonce: &[u8; FIELD_BYTES],
    browser_nonce: &[u8; FIELD_BYTES],
) -> String {
    let mut h = Sha256::new();
    h.update(SAS_DOMAIN);
    h.update(host_key);
    h.update(browser_key);
    h.update(host_nonce);
    h.update(browser_nonce);
    let digest = h.finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn matches_shared_vectors() {
        // Normative — identical assertions live in web/src/lib/sas.ts. Any drift
        // here silently weakens the check on one side of a pairing.
        let h = fill(0x01);
        let b = fill(0x02);
        let nd = fill(0x03);
        let nb = fill(0x04);
        assert_eq!(
            hex(&commit(&h, &nd)),
            "914ede519aab88e0f3b8ffb31dd94cfb80f23a75f2ad64af2d176f399958a044"
        );
        assert_eq!(sas(&h, &b, &nd, &nb), "449 728");

        let mut h2 = [0u8; 32];
        let mut b2 = [0u8; 32];
        for i in 0..32 {
            h2[i] = i as u8;
            b2[i] = (i + 32) as u8;
        }
        assert_eq!(sas(&h2, &b2, &fill(0xaa), &fill(0xbb)), "108 396");
    }

    #[test]
    fn commit_opens_and_rejects_tamper() {
        let h = fill(0x11);
        let nd = fill(0x22);
        let c = commit(&h, &nd);
        assert!(verify_commit(&c, &h, &nd));
        assert!(!verify_commit(&c, &fill(0x11), &fill(0x23))); // wrong nonce
        assert!(!verify_commit(&c, &fill(0x12), &nd)); // wrong key
    }

    #[test]
    fn substituting_either_key_changes_the_sas() {
        // The property the whole thing rests on: if the relay shows one side a
        // different key, that side's SAS diverges from the other's.
        let (h, b, nd, nb) = (fill(1), fill(2), fill(3), fill(4));
        let honest = sas(&h, &b, &nd, &nb);
        assert_ne!(honest, sas(&fill(9), &b, &nd, &nb)); // substituted host key
        assert_ne!(honest, sas(&h, &fill(9), &nd, &nb)); // substituted browser key
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
