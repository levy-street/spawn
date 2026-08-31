pub const STABLE_ENDPOINT: &str = "https://spawnd.dev/desktop/latest.json";
pub const BETA_ENDPOINT: &str = "https://spawnd.dev/desktop/beta/latest.json";

/// The channel of the deployment this build was made for, fixed at build time
/// beside the origin itself so the two can never drift apart.
pub const OWN_ENDPOINT: &str = concat!(env!("SPAWN_DESKTOP_SERVER_ORIGIN"), "/desktop/latest.json");

/// The updater channel this build may take an app from, if any.
///
/// A build takes updates from the deployment it points at, and only from that
/// one. The rule it enforces is that no update ever moves a machine between
/// fleets: a build made for a dev deployment must never check the vendor's
/// channel, because the first time production went ahead of it, it would
/// quietly replace itself with the production app. Nobody asked it to change
/// fleets. Reading its *own* deployment's channel is the opposite of that
/// mistake — it is how a dev deployment ships a fix to the apps it handed out.
///
/// What keeps a channel trustworthy is not its hostname but the offline
/// updater key compiled into this app: every payload on every channel carries
/// a detached signature made with that key, so an origin that serves an
/// update it did not have signed is refused. Publishing to a dev channel
/// therefore needs the same key a release does.
///
/// `None` for a plain-HTTP origin. An update is code, and a local development
/// origin is not somewhere to fetch code from with no transport authentication
/// at all; such a build is updated by whoever built it, by installing the next.
pub fn configured_endpoint() -> Option<&'static str> {
    endpoint_for(crate::models::HOSTED_ORIGIN, OWN_ENDPOINT)
}

/// `own` is the endpoint baked for `origin`; it is a parameter rather than a
/// constant so this stays a pure function the tests can drive with any origin.
fn endpoint_for(origin: &str, own: &'static str) -> Option<&'static str> {
    if origin == crate::models::VENDOR_ORIGIN {
        return Some(if cfg!(feature = "beta-updates") {
            BETA_ENDPOINT
        } else {
            STABLE_ENDPOINT
        });
    }
    origin.starts_with("https://").then_some(own)
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

    /// The endpoint a build for `origin` would bake, mirroring `OWN_ENDPOINT`'s
    /// `concat!` so the tests can talk about origins this build was not made
    /// for. Leaked deliberately: a mismatch here would be a test that passes
    /// while the shipped constant says something else.
    const DEV_OWN: &str = "https://dev.spawnd.dev:8330/desktop/latest.json";

    #[test]
    fn a_build_pointed_elsewhere_takes_that_deployments_updates_not_the_vendors() {
        // Asserted against the origin rather than whichever one this build
        // chose, so the test holds for a dev build too.
        assert_eq!(
            endpoint_for(crate::models::VENDOR_ORIGIN, DEV_OWN),
            Some(STABLE_ENDPOINT),
            "the vendor's own build stays on the vendor's channel"
        );
        // Every one of these is somebody's own deployment, and each takes
        // updates from itself. None of them may be handed the vendor's.
        for elsewhere in [
            "https://dev.spawnd.dev:8330",
            "https://spawnd.dev.evil.test",
            "https://spawnd.dev:8443",
        ] {
            assert_eq!(
                endpoint_for(elsewhere, DEV_OWN),
                Some(DEV_OWN),
                "{elsewhere} updates from itself"
            );
            assert_ne!(
                endpoint_for(elsewhere, DEV_OWN),
                Some(STABLE_ENDPOINT),
                "{elsewhere} must never reach the vendor's channel"
            );
        }
    }

    #[test]
    fn a_plain_http_build_takes_no_updates_at_all() {
        // An update is code. A loopback development origin has no transport
        // authentication to fetch it over, so this build is updated by hand.
        for insecure in ["http://localhost:3000", "http://127.0.0.1:8010"] {
            assert_eq!(
                endpoint_for(insecure, DEV_OWN),
                None,
                "{insecure} is not somewhere to fetch code from"
            );
        }
    }

    #[test]
    fn the_baked_own_endpoint_is_this_builds_origin() {
        assert_eq!(
            OWN_ENDPOINT,
            format!("{}/desktop/latest.json", crate::models::HOSTED_ORIGIN),
            "OWN_ENDPOINT must name the origin this build actually points at"
        );
    }

    #[test]
    fn stable_and_beta_channels_remain_vendor_pinned() {
        assert_eq!(STABLE_ENDPOINT, "https://spawnd.dev/desktop/latest.json");
        assert_eq!(BETA_ENDPOINT, "https://spawnd.dev/desktop/beta/latest.json");
        assert!(endpoint_for(crate::models::VENDOR_ORIGIN, DEV_OWN)
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
