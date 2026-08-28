/// The server a build points at when nobody says otherwise.
const VENDOR_ORIGIN: &str = "https://spawnd.dev";

/// Where this build of SPAWN D looks for a server, chosen at build time.
///
/// A build downloaded from a dev deployment that then talks to production is
/// not a dev build at all, and the mistake is invisible: the app opens, signs
/// in, and possesses the wrong fleet. `mobile/eas.json` settles the same
/// question per profile with `EXPO_PUBLIC_API_URL`; this is that, for the
/// desktop app.
///
/// Unset means production, so an ordinary release build needs no ceremony.
fn server_origin() -> String {
    let Ok(origin) = std::env::var("SPAWN_DESKTOP_SERVER_ORIGIN") else {
        return VENDOR_ORIGIN.to_owned();
    };
    let origin = origin.trim().to_owned();
    // Fail the build rather than bake in something the app will reject at
    // runtime, when the only symptom is an app that cannot reach any server.
    assert!(
        origin.starts_with("https://") || origin.starts_with("http://"),
        "SPAWN_DESKTOP_SERVER_ORIGIN must be an http or https origin, got {origin:?}"
    );
    assert!(
        !origin.ends_with('/'),
        "SPAWN_DESKTOP_SERVER_ORIGIN must not end in a slash, got {origin:?}"
    );
    assert!(
        !origin.contains(char::is_whitespace),
        "SPAWN_DESKTOP_SERVER_ORIGIN must not contain whitespace, got {origin:?}"
    );
    origin
}

fn main() {
    println!("cargo:rerun-if-env-changed=SPAWN_DESKTOP_SERVER_ORIGIN");
    println!(
        "cargo:rustc-env=SPAWN_DESKTOP_SERVER_ORIGIN={}",
        server_origin()
    );
    println!("cargo:rustc-env=SPAWN_DESKTOP_VENDOR_ORIGIN={VENDOR_ORIGIN}");
    tauri_build::build()
}
