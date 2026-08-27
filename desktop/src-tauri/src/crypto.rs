use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use spawnd::acct_endorsement::{self, AcctEndorsementTranscript};
use spawnd::host_pair_approval::{self, HostPairApprovalTranscript};
use spawnd::signed_signal::{generate_signing_key, public_key_from_wire, public_key_to_wire};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::storage;

const REGISTRATION_MAGIC: &[u8] = b"SPAWN-BROWSER-REGISTER-V2";
const REGISTRATION_VERSION: u8 = 2;
const HOST_INTRO_MAGIC: &[u8] = b"SPAWN-HOST-INTRO-BCAST-V1";
const HOST_INTRO_VERSION: u8 = 1;

pub struct DeviceIdentity {
    signing_key: SigningKey,
}

impl DeviceIdentity {
    pub fn load_or_create(account_id: &str) -> Result<Self> {
        let signing_key = match storage::device_seed(account_id)? {
            Some(encoded) => {
                let mut seed: [u8; 32] = URL_SAFE_NO_PAD
                    .decode(encoded.as_bytes())
                    .context("decoding the secure credential-store device identity")?
                    .try_into()
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "the secure credential-store device identity has the wrong length"
                        )
                    })?;
                let key = SigningKey::from_bytes(&seed);
                seed.zeroize();
                key
            }
            None => {
                let key =
                    generate_signing_key().context("generating the desktop device identity")?;
                let mut seed = key.to_bytes();
                let encoded = URL_SAFE_NO_PAD.encode(seed);
                storage::set_device_seed(account_id, &encoded)?;
                seed.zeroize();
                key
            }
        };
        Ok(Self { signing_key })
    }

    pub fn public_key_wire(&self) -> String {
        public_key_to_wire(&self.signing_key.verifying_key())
    }

    pub fn registration_proof(&self, account_id: &str) -> Result<String> {
        let account = canonical_uuid(account_id)?;
        let mut transcript = Vec::with_capacity(REGISTRATION_MAGIC.len() + 50);
        transcript.extend_from_slice(REGISTRATION_MAGIC);
        transcript.push(REGISTRATION_VERSION);
        transcript.extend_from_slice(account.as_bytes());
        transcript.push(0); // An ordinary revocable device, never the account root.
        transcript.extend_from_slice(self.signing_key.verifying_key().as_bytes());
        Ok(URL_SAFE_NO_PAD.encode(self.signing_key.sign(&transcript).to_bytes()))
    }

    pub fn host_approval_proof(
        &self,
        account_id: &str,
        approval_nonce: &str,
        host_public_key: &str,
    ) -> Result<String> {
        let transcript = HostPairApprovalTranscript::from_wire(
            account_id,
            approval_nonce,
            host_public_key,
            &self.public_key_wire(),
        )
        .context("constructing SPAWN-HOST-PAIR-APPROVE-V1")?;
        Ok(host_pair_approval::signature_to_wire(
            &host_pair_approval::sign_transcript(&self.signing_key, &transcript),
        ))
    }

    pub fn account_endorsement(
        &self,
        account_id: &str,
        endorsed_public_key: &str,
        endorsed_device_id: &str,
    ) -> Result<String> {
        let transcript = AcctEndorsementTranscript::from_wire(
            account_id,
            &self.public_key_wire(),
            endorsed_public_key,
            endorsed_device_id,
        )
        .context("constructing SPAWN-ACCT-ENDORSE-V1")?;
        Ok(acct_endorsement::signature_to_wire(
            &acct_endorsement::sign_transcript(&self.signing_key, &transcript),
        ))
    }

    pub fn host_introduction_proof(
        &self,
        account_id: &str,
        host_public_key: &str,
    ) -> Result<String> {
        let account = canonical_uuid(account_id)?;
        let host = public_key_from_wire(host_public_key).context("decoding host public key")?;
        let mut transcript = Vec::with_capacity(HOST_INTRO_MAGIC.len() + 81);
        transcript.extend_from_slice(HOST_INTRO_MAGIC);
        transcript.push(HOST_INTRO_VERSION);
        transcript.extend_from_slice(account.as_bytes());
        transcript.extend_from_slice(self.signing_key.verifying_key().as_bytes());
        transcript.extend_from_slice(host.as_bytes());
        Ok(URL_SAFE_NO_PAD.encode(self.signing_key.sign(&transcript).to_bytes()))
    }
}

fn canonical_uuid(value: &str) -> Result<Uuid> {
    let parsed = Uuid::parse_str(value).context("parsing account UUID")?;
    if parsed.to_string() != value {
        bail!("account UUID is not canonical")
    }
    Ok(parsed)
}

pub fn key_fingerprint(public_key_wire: &str) -> Result<String> {
    let key = public_key_from_wire(public_key_wire).context("decoding Ed25519 public key")?;
    let digest = Sha256::digest(key.as_bytes());
    Ok(format!("SHA256:{}", URL_SAFE_NO_PAD.encode(&digest[..12])))
}

pub fn decode_wire32(value: &str) -> Result<[u8; 32]> {
    let decoded: [u8; 32] = URL_SAFE_NO_PAD
        .decode(value)
        .context("decoding canonical base64url value")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected a 32-byte base64url value"))?;
    if URL_SAFE_NO_PAD.encode(decoded) != value {
        bail!("base64url value is not canonical")
    }
    Ok(decoded)
}

pub fn ceremony_number(
    initiator_key: &str,
    joiner_key: &str,
    initiator_nonce: &str,
    joiner_nonce: &str,
) -> Result<String> {
    let six = spawnd::sas::sas(
        &decode_wire32(initiator_key)?,
        &decode_wire32(joiner_key)?,
        &decode_wire32(initiator_nonce)?,
        &decode_wire32(joiner_nonce)?,
    );
    let value: u32 = six.replace(' ', "").parse()?;
    let four = value % 10_000;
    Ok(format!("{:02} {:02}", four / 100, four % 100))
}

pub fn commitment_opens(commitment: &str, key: &str, nonce: &str) -> Result<bool> {
    Ok(spawnd::sas::verify_commit(
        &decode_wire32(commitment)?,
        &decode_wire32(key)?,
        &decode_wire32(nonce)?,
    ))
}

pub fn verify_account_endorsement(
    account_id: &str,
    endorser_key: &str,
    endorsed_key: &str,
    endorsed_device_id: &str,
    signature: &str,
) -> Result<()> {
    let transcript = AcctEndorsementTranscript::from_wire(
        account_id,
        endorser_key,
        endorsed_key,
        endorsed_device_id,
    )?;
    let signature = acct_endorsement::signature_from_wire(signature)?;
    let endorser = public_key_from_wire(endorser_key)?;
    acct_endorsement::verify_endorsement(&transcript, &signature, &[endorser])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_ceremony_uses_the_mobile_four_digit_projection() {
        let wire = |byte| URL_SAFE_NO_PAD.encode([byte; 32]);
        assert_eq!(
            ceremony_number(&wire(1), &wire(2), &wire(3), &wire(4)).unwrap(),
            "97 28"
        );
        assert!(commitment_opens(
            &URL_SAFE_NO_PAD.encode(spawnd::sas::commit(&[1; 32], &[3; 32])),
            &wire(1),
            &wire(3)
        )
        .unwrap());
    }

    #[test]
    fn fingerprints_use_the_daemon_wire_format() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let wire = public_key_to_wire(&key.verifying_key());
        let fingerprint = key_fingerprint(&wire).unwrap();
        assert!(fingerprint.starts_with("SHA256:"));
        assert_eq!(fingerprint.len(), 23);
    }
}
