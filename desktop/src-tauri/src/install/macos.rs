use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

use super::DownloadedPair;

pub(super) fn install_pair(pair: DownloadedPair, _origin: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().context("the home directory is unavailable")?;
    let bin_dir = home.join(".local/bin");
    fs::create_dir_all(&bin_dir)?;
    let spawnd = bin_dir.join("spawnd");
    let worker = bin_dir.join("spawn-worker");
    let staged_spawnd = bin_dir.join(format!(".spawnd.desktop.{}", std::process::id()));
    let staged_worker = bin_dir.join(format!(".spawn-worker.desktop.{}", std::process::id()));
    write_executable(&staged_spawnd, &pair.spawnd)?;
    if let Err(error) = write_executable(&staged_worker, &pair.worker) {
        let _ = fs::remove_file(&staged_spawnd);
        return Err(error);
    }
    if let Err(error) =
        verify_executable(&staged_spawnd).and_then(|()| verify_executable(&staged_worker))
    {
        let _ = fs::remove_file(&staged_spawnd);
        let _ = fs::remove_file(&staged_worker);
        return Err(error);
    }
    let backup_spawnd = bin_dir.join(".spawnd.desktop-prev");
    let backup_worker = bin_dir.join(".spawn-worker.desktop-prev");
    let had_spawnd = move_if_exists(&spawnd, &backup_spawnd)?;
    let had_worker = move_if_exists(&worker, &backup_worker)?;
    let install = (|| -> Result<()> {
        fs::rename(&staged_spawnd, &spawnd)?;
        fs::rename(&staged_worker, &worker)?;
        Ok(())
    })();
    if let Err(error) = install {
        let _ = fs::remove_file(&spawnd);
        let _ = fs::remove_file(&worker);
        if had_spawnd {
            let _ = fs::rename(&backup_spawnd, &spawnd);
        }
        if had_worker {
            let _ = fs::rename(&backup_worker, &worker);
        }
        let _ = fs::remove_file(&staged_spawnd);
        let _ = fs::remove_file(&staged_worker);
        return Err(error).context("installing the verified daemon pair");
    }
    let _ = fs::remove_file(backup_spawnd);
    let _ = fs::remove_file(backup_worker);
    Ok(bin_dir)
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
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

fn move_if_exists(source: &Path, target: &Path) -> Result<bool> {
    match fs::rename(source, target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
