pub const STABLE_ENDPOINT: &str = "https://spawnd.dev/desktop/latest.json";
pub const BETA_ENDPOINT: &str = "https://spawnd.dev/desktop/beta/latest.json";

/// The updater channel this build may take an app from, if any.
///
/// `None` when the build points at a server other than the vendor's. The
/// endpoint in `tauri.conf.json` is the vendor's and is signed by the vendor's
/// offline key, so a build made for a dev deployment would sit there checking
/// production and, the first time production went ahead of it, quietly replace
/// itself with the production app. Nobody asked it to change fleets.
///
/// Such a build is updated by whoever built it — by installing the next one.
pub fn configured_endpoint() -> Option<&'static str> {
    endpoint_for(crate::models::HOSTED_ORIGIN)
}

fn endpoint_for(origin: &str) -> Option<&'static str> {
    if origin != crate::models::VENDOR_ORIGIN {
        return None;
    }
    Some(if cfg!(feature = "beta-updates") {
        BETA_ENDPOINT
    } else {
        STABLE_ENDPOINT
    })
}

#[cfg(test)]
#[derive(Debug, serde::Deserialize)]
struct LatestManifest {
    version: String,
    platforms: std::collections::BTreeMap<String, LatestPlatform>,
}

#[cfg(test)]
#[derive(Debug, serde::Deserialize)]
struct LatestPlatform {
    signature: String,
    url: String,
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
    fn a_build_pointed_elsewhere_takes_no_vendor_updates() {
        // Asserted against the origin rather than whichever one this build
        // chose, so the test holds for a dev build too.
        assert_eq!(
            endpoint_for(crate::models::VENDOR_ORIGIN),
            Some(STABLE_ENDPOINT)
        );
        for elsewhere in [
            "https://dev.spawnd.dev:8330",
            "http://localhost:3000",
            "https://spawnd.dev.evil.test",
            "https://spawnd.dev:8443",
        ] {
            assert_eq!(
                endpoint_for(elsewhere),
                None,
                "{elsewhere} is not the vendor"
            );
        }
    }

    #[test]
    fn stable_and_beta_channels_remain_vendor_pinned() {
        assert_eq!(STABLE_ENDPOINT, "https://spawnd.dev/desktop/latest.json");
        assert_eq!(BETA_ENDPOINT, "https://spawnd.dev/desktop/beta/latest.json");
        assert!(endpoint_for(crate::models::VENDOR_ORIGIN)
            .expect("the vendor origin keeps its channel")
            .starts_with("https://spawnd.dev/desktop/"));
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
    fn updater_manifest_keeps_all_three_platform_payload_contracts() {
        let bytes = br#"{
          "version":"0.2.0",
          "notes":"Windows support",
          "pub_date":"2026-08-27T00:00:00Z",
          "platforms":{
            "darwin-aarch64":{"signature":"arm-sig","url":"https://spawnd.dev/desktop/SPAWN-D_0.2.0_darwin-aarch64.app.tar.gz"},
            "darwin-x86_64":{"signature":"intel-sig","url":"https://spawnd.dev/desktop/SPAWN-D_0.2.0_darwin-x86_64.app.tar.gz"},
            "windows-x86_64":{"signature":"win-sig","url":"https://spawnd.dev/desktop/SPAWN-D_0.2.0_windows-x86_64-setup.exe"}
          }
        }"#;
        let manifest: LatestManifest = serde_json::from_slice(bytes).unwrap();
        let mut platforms = manifest.platforms.keys().cloned().collect::<Vec<_>>();
        platforms.sort();
        assert_eq!(
            platforms,
            ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]
        );
        let windows = &manifest.platforms["windows-x86_64"];
        assert_eq!(windows.signature, "win-sig");
        assert_eq!(
            windows.url,
            "https://spawnd.dev/desktop/SPAWN-D_0.2.0_windows-x86_64-setup.exe"
        );
        assert!(!windows.url.ends_with(".zip"));
    }

    #[test]
    fn tauri_configs_pin_the_committed_key_and_both_vendor_channels() {
        let stable: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let beta: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.beta.conf.json")).unwrap();
        let windows: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.windows.conf.json")).unwrap();
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
        assert_eq!(
            windows.pointer("/bundle/windows/nsis/installMode"),
            Some(&serde_json::Value::String("currentUser".into()))
        );
        assert_eq!(
            windows.pointer("/bundle/windows/webviewInstallMode/type"),
            Some(&serde_json::Value::String("downloadBootstrapper".into()))
        );
        assert_eq!(
            windows.pointer("/plugins/updater/windows/installMode"),
            Some(&serde_json::Value::String("passive".into()))
        );
    }
}
