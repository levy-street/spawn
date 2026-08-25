pub const STABLE_ENDPOINT: &str = "https://spawnd.dev/desktop/latest.json";
pub const BETA_ENDPOINT: &str = "https://spawnd.dev/desktop/beta/latest.json";

pub fn configured_endpoint() -> &'static str {
    if cfg!(feature = "beta-updates") {
        BETA_ENDPOINT
    } else {
        STABLE_ENDPOINT
    }
}

#[cfg(test)]
#[derive(Debug, serde::Deserialize)]
struct LatestManifest {
    version: String,
    platforms: serde_json::Map<String, serde_json::Value>,
}

#[cfg(test)]
pub fn parse_latest_manifest(bytes: &[u8]) -> anyhow::Result<(String, Vec<String>)> {
    use anyhow::bail;
    let manifest: LatestManifest = serde_json::from_slice(bytes)?;
    if manifest.version.trim().is_empty() || manifest.platforms.is_empty() {
        bail!("desktop updater manifest is incomplete")
    }
    Ok((
        manifest.version,
        manifest.platforms.keys().cloned().collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_and_beta_channels_remain_vendor_pinned() {
        assert_eq!(STABLE_ENDPOINT, "https://spawnd.dev/desktop/latest.json");
        assert_eq!(BETA_ENDPOINT, "https://spawnd.dev/desktop/beta/latest.json");
        assert!(configured_endpoint().starts_with("https://spawnd.dev/desktop/"));
    }

    #[test]
    fn updater_manifest_parser_requires_version_and_platform() {
        let parsed = parse_latest_manifest(
            br#"{"version":"0.2.0","notes":"","pub_date":"2026-08-26T00:00:00Z","platforms":{"darwin-aarch64":{"signature":"sig","url":"https://spawnd.dev/desktop/app.tar.gz"}}}"#,
        )
        .unwrap();
        assert_eq!(parsed.0, "0.2.0");
        assert_eq!(parsed.1, vec!["darwin-aarch64"]);
        assert!(parse_latest_manifest(br#"{"version":"0.2.0","platforms":{}}"#).is_err());
    }

    #[test]
    fn tauri_configs_pin_the_committed_key_and_both_vendor_channels() {
        let stable: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let beta: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.beta.conf.json")).unwrap();
        assert_eq!(
            stable.pointer("/plugins/updater/endpoints/0"),
            Some(&serde_json::Value::String(STABLE_ENDPOINT.into()))
        );
        assert_eq!(
            beta.pointer("/plugins/updater/endpoints/0"),
            Some(&serde_json::Value::String(BETA_ENDPOINT.into()))
        );
        assert_eq!(
            stable
                .pointer("/plugins/updater/pubkey")
                .and_then(|value| value.as_str()),
            Some(include_str!("../../updater.pubkey").trim())
        );
    }
}
