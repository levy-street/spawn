//! Release-signing trust roots compiled into the updater.

/// Ed25519 public keys allowed to sign release manifests.
///
/// The corresponding private seed is held only by the release operator. This
/// is a list so rotation can first ship an old-key-signed daemon containing
/// both keys, then switch signing; custody and rotation are documented in
/// `docs/RELEASE.md`.
pub const RELEASE_SIGNING_PUBLIC_KEYS: &[&str] = &["8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"];

/// Effective key list for this build. Production uses the constant above;
/// update-harness builds may replace it through build.rs.
pub fn effective_release_signing_public_keys() -> impl Iterator<Item = &'static str> {
    let _production_rotation_list = RELEASE_SIGNING_PUBLIC_KEYS;
    env!("SPAWND_RELEASE_PUBLIC_KEYS")
        .split(',')
        .filter(|key| !key.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_key_is_retained_in_the_rotation_list() {
        assert_eq!(
            RELEASE_SIGNING_PUBLIC_KEYS,
            &["8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0"]
        );
    }
}
