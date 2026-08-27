use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

use super::{installer_command_for, DownloadedPair};

pub(super) fn install_pair(pair: DownloadedPair, origin: &str) -> Result<PathBuf> {
    let local = dirs::data_local_dir()
        .context("the Windows local application-data directory is unavailable")?;
    install_pair_at(local.join("spawn").join("bin"), pair, origin)
}

fn install_pair_at(bin_dir: PathBuf, pair: DownloadedPair, origin: &str) -> Result<PathBuf> {
    fs::create_dir_all(&bin_dir)?;
    let spawnd = bin_dir.join("spawnd.exe");
    let worker = bin_dir.join("spawn-worker.exe");
    let state = install_state(&spawnd, &worker);

    if state == InstallState::Complete
        && installed_hashes_match(&spawnd, &worker, &pair).unwrap_or(false)
    {
        return Ok(bin_dir);
    }
    if state == InstallState::Empty {
        fresh_install(&bin_dir, &pair)?;
        return Ok(bin_dir);
    }

    // An executing Windows image cannot be assumed renameable. Any state in
    // which either destination exists belongs to the daemon's self-updater;
    // the desktop app never writes, renames, or removes that live pair.
    if !spawnd.is_file() {
        bail!(repair_error(
            origin,
            "spawnd.exe is missing, so its self-updater cannot run"
        ))
    }
    let output = Command::new(&spawnd)
        .arg("--server")
        .arg(origin)
        .arg("update")
        .env("NO_COLOR", "1")
        .output()
        .context("handing the installed daemon to its self-updater")?;
    if !output.status.success() {
        let detail = combined_output(&output);
        bail!(repair_error(
            origin,
            &format!("the daemon self-updater failed: {detail}")
        ))
    }

    // The Windows updater may complete its two-file swap through a helper
    // after the original supervisor exits. Re-read both files for a short,
    // bounded interval instead of accepting process exit as proof.
    for _ in 0..30 {
        if installed_hashes_match(&spawnd, &worker, &pair).unwrap_or(false) {
            return Ok(bin_dir);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    bail!(repair_error(
        origin,
        "the daemon self-updater returned but the installed pair did not match the signed release"
    ))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InstallState {
    Empty,
    Partial,
    Complete,
}

fn install_state(spawnd: &Path, worker: &Path) -> InstallState {
    match (spawnd.exists(), worker.exists()) {
        (false, false) => InstallState::Empty,
        (true, true) => InstallState::Complete,
        _ => InstallState::Partial,
    }
}

fn fresh_install(bin_dir: &Path, pair: &DownloadedPair) -> Result<()> {
    let nonce = std::process::id();
    let staged_spawnd = bin_dir.join(format!("spawnd.desktop.{nonce}.exe"));
    let staged_worker = bin_dir.join(format!("spawn-worker.desktop.{nonce}.exe"));
    fs::write(&staged_spawnd, &pair.spawnd)?;
    if let Err(error) = fs::write(&staged_worker, &pair.worker) {
        let _ = fs::remove_file(&staged_spawnd);
        return Err(error.into());
    }
    let verify = verify_executable(&staged_spawnd).and_then(|()| verify_executable(&staged_worker));
    if let Err(error) = verify {
        let _ = fs::remove_file(&staged_spawnd);
        let _ = fs::remove_file(&staged_worker);
        return Err(error);
    }
    let spawnd = bin_dir.join("spawnd.exe");
    let worker = bin_dir.join("spawn-worker.exe");
    if let Err(error) =
        fs::rename(&staged_spawnd, &spawnd).and_then(|()| fs::rename(&staged_worker, &worker))
    {
        let _ = fs::remove_file(&spawnd);
        let _ = fs::remove_file(&worker);
        let _ = fs::remove_file(&staged_spawnd);
        let _ = fs::remove_file(&staged_worker);
        return Err(error).context("installing the fresh verified daemon pair");
    }
    Ok(())
}

fn verify_executable(path: &Path) -> Result<()> {
    let output = Command::new(path)
        .arg("--version")
        .output()
        .with_context(|| format!("checking {}", path.display()))?;
    if !output.status.success() {
        bail!("{} did not report its version", path.display())
    }
    Ok(())
}

fn installed_hashes_match(spawnd: &Path, worker: &Path, pair: &DownloadedPair) -> Result<bool> {
    Ok(file_sha256(spawnd)? == pair.spawnd_sha256 && file_sha256(worker)? == pair.worker_sha256)
}

fn file_sha256(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn repair_error(origin: &str, detail: &str) -> String {
    format!(
        "{detail}. Nothing was replaced. Repair from PowerShell with: {}",
        installer_command_for(origin, "windows")
    )
}

fn combined_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{stdout}{stderr}");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        format!("exit status {}", output.status)
    } else {
        trimmed.chars().take(4096).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_states_never_treat_a_partial_pair_as_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let spawnd = dir.path().join("spawnd.exe");
        let worker = dir.path().join("spawn-worker.exe");
        assert_eq!(install_state(&spawnd, &worker), InstallState::Empty);
        fs::write(&worker, b"old worker").unwrap();
        assert_eq!(install_state(&spawnd, &worker), InstallState::Partial);
        fs::write(&spawnd, b"old daemon").unwrap();
        assert_eq!(install_state(&spawnd, &worker), InstallState::Complete);
    }

    #[test]
    fn repair_copy_is_safe_and_platform_native() {
        let copy = repair_error("https://spawnd.dev", "update failed");
        assert!(copy.contains("Nothing was replaced"));
        assert!(copy.contains("irm https://spawnd.dev/install.ps1 | iex"));
    }
}
