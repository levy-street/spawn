// Stamp every build with its source commit. The version the daemon prints and
// reports to the server reads this: after the 2026-08-24 incident, "0.1.0"
// alone could not tell a stale binary from its replacement. A build outside a
// git checkout (or without git on PATH) stamps the bare crate version rather
// than failing the build.

use std::process::Command;

fn main() {
    let pkg_version = std::env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION");
    let commit = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|stdout| stdout.trim().to_string())
        .unwrap_or_default();
    // The suffix is semver build metadata: comparisons ignore it, humans and
    // logs comparing a running daemon against a release no longer have to.
    let version = if commit.is_empty() {
        pkg_version
    } else {
        format!("{pkg_version}+g{commit}")
    };
    println!("cargo:rustc-env=SPAWND_BUILD_VERSION={version}");

    // Re-stamp when HEAD moves; .git sits at the repo root, one level up.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../.git/HEAD") {
        if let Some(reference) = head.strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../.git/{}", reference.trim());
        }
    }
}
