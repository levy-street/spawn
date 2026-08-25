// Stamp every build with its source commit. The version the daemon prints and
// reports to the server reads this: after the 2026-08-24 incident, "0.1.0"
// alone could not tell a stale binary from its replacement. A build outside a
// git checkout (or without git on PATH) stamps the bare crate version rather
// than failing the build.

use std::process::Command;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let pkg_version = std::env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION");
    let commit = Command::new("git")
        .current_dir(&manifest_dir)
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

    // A tree identity changes only when daemon/ content changes, unlike the
    // repository commit stamped into the human-readable version. Dirty builds
    // are deliberately distinct so release comparison can decline to update
    // either side while a developer is working locally.
    println!("cargo:rerun-if-env-changed=SPAWND_DAEMON_TREE_OVERRIDE");
    println!("cargo:rerun-if-env-changed=SPAWND_BUILD_COUNTER_OVERRIDE");
    println!("cargo:rerun-if-env-changed=SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE");

    let tree_override = std::env::var("SPAWND_DAEMON_TREE_OVERRIDE").unwrap_or_default();
    let tree = Command::new("git")
        .current_dir(&manifest_dir)
        .args(["rev-parse", "HEAD:daemon"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|stdout| stdout.trim().to_string())
        .unwrap_or_default();
    let tree = if !tree_override.is_empty() {
        tree_override
    } else if tree.is_empty() {
        tree
    } else {
        let clean = Command::new("git")
            .current_dir(&manifest_dir)
            .args(["diff", "--quiet", "HEAD", "--", "."])
            .status()
            .is_ok_and(|status| status.success());
        if clean {
            tree
        } else {
            format!("{tree}-dirty")
        }
    };
    println!("cargo:rustc-env=SPAWND_DAEMON_TREE={tree}");

    let counter = std::env::var("SPAWND_BUILD_COUNTER_OVERRIDE")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            Command::new("git")
                .current_dir(&manifest_dir)
                .args(["show", "-s", "--format=%ct", "HEAD"])
                .output()
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|stdout| stdout.trim().to_string())
                .unwrap_or_default()
        });
    println!("cargo:rustc-env=SPAWND_BUILD_COUNTER={counter}");

    let release_keys = std::env::var("SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "8nE_rD4eVv8QFuNMbBQ3023vuU7V-OWxRl70ni4WOf0".to_string());
    println!("cargo:rustc-env=SPAWND_RELEASE_PUBLIC_KEYS={release_keys}");

    // Re-stamp when HEAD moves; .git sits at the repo root, one level up.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../.git/HEAD") {
        if let Some(reference) = head.strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../.git/{}", reference.trim());
        }
    }
    for path in ["src", "build.rs", "Cargo.toml", "Cargo.lock"] {
        println!("cargo:rerun-if-changed={path}");
    }
}
