// Stamp every build with its source commit. The version the daemon prints and
// reports to the server reads this: after the 2026-08-24 incident, "0.1.0"
// alone could not tell a stale binary from its replacement. A build outside a
// git checkout (or without git on PATH) stamps the bare crate version rather
// than failing the build.

use std::path::Path;
use std::process::Command;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let pkg_version = std::env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION");

    embed_info_plist(&manifest_dir, &pkg_version);
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

/// Link `Info.plist` into both macOS binaries.
///
/// A bare Mach-O has nowhere to keep an Info.plist, so macOS asks for consent
/// on behalf of a lower-case path with no product name and no explanation.
/// `-sectcreate __TEXT __info_plist` gives the file one anyway: the same bytes
/// an app bundle would keep beside its executable, sealed inside it, which is
/// where TCC and codesign both look. See `Info.plist` for what those bytes say
/// and why each key is there.
fn embed_info_plist(manifest_dir: &str, pkg_version: &str) {
    println!("cargo:rerun-if-changed=Info.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let source = Path::new(manifest_dir).join("Info.plist");
    let Ok(template) = std::fs::read_to_string(&source) else {
        // Never fail the build over presentation: a daemon that builds without
        // its consent copy is worse-mannered, not broken.
        println!("cargo:warning=daemon/Info.plist is missing; macOS consent dialogs will name the binary path instead of SPAWN D");
        return;
    };
    // The version is stamped rather than kept in the file so the two cannot
    // drift, the way SPAWND_BUILD_VERSION already is.
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    let stamped = Path::new(&out_dir).join("Info.plist");
    let rendered = template.replace("__SPAWND_VERSION__", pkg_version);
    if let Err(error) = std::fs::write(&stamped, rendered) {
        println!("cargo:warning=could not stage daemon/Info.plist ({error}); macOS consent dialogs will name the binary path instead of SPAWN D");
        return;
    }
    // One `-Xlinker` per argument rather than a single comma-joined `-Wl,`:
    // the path is a build directory nobody chose, and a comma or a space in it
    // would silently truncate the section name under the `-Wl,` form.
    for bin in ["spawnd", "spawn-worker"] {
        for argument in [
            "-Xlinker",
            "-sectcreate",
            "-Xlinker",
            "__TEXT",
            "-Xlinker",
            "__info_plist",
            "-Xlinker",
            &stamped.to_string_lossy(),
        ] {
            println!("cargo:rustc-link-arg-bin={bin}={argument}");
        }
    }
}
