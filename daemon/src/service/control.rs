//! Owner-only per-instance Windows supervisor control pipe.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const MAX_REQUEST_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ControlCommand {
    Ping,
    Reconnect,
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    v: u8,
    command: ControlCommand,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlReply {
    v: u8,
    ok: bool,
    pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn decode_request(bytes: &[u8]) -> Result<ControlCommand> {
    if bytes.len() > MAX_REQUEST_BYTES {
        bail!("control request is oversized");
    }
    if !bytes.ends_with(b"\n") {
        bail!("control request is not newline terminated");
    }
    let request: ControlRequest =
        serde_json::from_slice(bytes).context("decoding control request")?;
    if request.v != 1 {
        bail!("unsupported control protocol version");
    }
    Ok(request.command)
}

fn success_reply() -> Vec<u8> {
    let reply = ControlReply {
        v: 1,
        ok: true,
        pid: std::process::id(),
        error: None,
    };
    let mut bytes = serde_json::to_vec(&reply).expect("serializing fixed control reply");
    bytes.push(b'\n');
    bytes
}

fn error_reply(detail: &str) -> Vec<u8> {
    let reply = ControlReply {
        v: 1,
        ok: false,
        pid: std::process::id(),
        error: Some(detail.to_owned()),
    };
    let mut bytes = serde_json::to_vec(&reply).expect("serializing fixed control reply");
    bytes.push(b'\n');
    bytes
}

pub fn pipe_name_for(sid: &str, config_dir: &Path) -> String {
    format!(
        r"\\.\pipe\spawn-{sid}-{}-control",
        super::instance_name(config_dir)
    )
}

#[cfg(windows)]
pub fn pipe_name(config_dir: &Path) -> Result<String> {
    Ok(pipe_name_for(&current_user_sid()?, config_dir))
}

#[cfg(not(windows))]
pub fn pipe_name(config_dir: &Path) -> Result<String> {
    let _ = config_dir;
    bail!("Windows control pipes are unavailable on this platform")
}

#[cfg(windows)]
pub fn start_listener(
    config_dir: &Path,
    reconnect: &'static tokio::sync::Notify,
    shutdown: &'static tokio::sync::Notify,
) -> Result<()> {
    use std::mem::size_of;
    use std::ptr;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

    let name = pipe_name(config_dir)?;
    let sid = current_user_sid()?;
    let sddl = to_utf16(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})"));
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated and `descriptor` receives LocalAlloc
    // memory which is retained through CreateNamedPipe and then LocalFree'd.
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(std::io::Error::last_os_error())
            .context("building the owner-only control-pipe security descriptor");
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let server = {
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(true)
            .pipe_mode(PipeMode::Message)
            .reject_remote_clients(true)
            .in_buffer_size((MAX_REQUEST_BYTES + 1) as u32)
            .out_buffer_size(512);
        // SAFETY: `attributes` and its descriptor remain valid for the entire
        // synchronous CreateNamedPipe call. Tokio does not retain the pointer.
        unsafe {
            options.create_with_security_attributes_raw(
                &name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
        }
    };
    // SAFETY: ConvertStringSecurityDescriptor allocated this exact pointer.
    unsafe {
        LocalFree(descriptor.cast());
    }
    let mut server = server.context("creating the owner-only SPAWN D control pipe")?;

    tokio::spawn(async move {
        loop {
            if let Err(error) = server.connect().await {
                tracing::error!(%error, "SPAWN D control pipe stopped accepting clients");
                return;
            }
            let mut request = vec![0_u8; MAX_REQUEST_BYTES + 1];
            let result = server.read(&mut request).await;
            let command = match result {
                Ok(size) => {
                    request.truncate(size);
                    decode_request(&request)
                }
                // A read that fails because the client is already gone — the
                // instance was recycled under it, or a connect completed with
                // nobody on the other end, which a loaded machine produces —
                // has nobody to answer. Writing an error reply here only
                // races the next client, who would read a rejection meant
                // for no one (and never retry it). Recycle the instance and
                // listen again; the client side retries within its deadline.
                Err(error) if is_gone_client(&error) => {
                    let _ = server.disconnect();
                    continue;
                }
                Err(error) => Err(error.into()),
            };
            match command {
                Ok(command) => {
                    if server.write_all(&success_reply()).await.is_ok() {
                        let _ = server.flush().await;
                        match command {
                            ControlCommand::Ping => {}
                            ControlCommand::Reconnect => reconnect.notify_one(),
                            ControlCommand::Shutdown => shutdown.notify_one(),
                        }
                    }
                }
                Err(error) => {
                    let _ = server.write_all(&error_reply(&error.to_string())).await;
                    let _ = server.flush().await;
                }
            }
            if let Err(error) = server.disconnect() {
                tracing::warn!(%error, "could not disconnect SPAWN D control-pipe client");
            }
        }
    });
    Ok(())
}

#[cfg(not(windows))]
pub fn start_listener(
    config_dir: &Path,
    reconnect: &'static tokio::sync::Notify,
    shutdown: &'static tokio::sync::Notify,
) -> Result<()> {
    let _ = (config_dir, reconnect, shutdown);
    Ok(())
}

#[cfg(windows)]
pub fn send(config_dir: &Path, command: ControlCommand) -> Result<u32> {
    let name = pipe_name(config_dir)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        // The listener serves one client per pipe instance and recycles the
        // instance between clients, and DisconnectNamedPipe discards a framed
        // reply the client has not read yet. That surfaces as "no process is
        // on the other end of the pipe" (233) or a broken pipe — and not only
        // mid-exchange: the recycle can land between our CreateFile and the
        // SetNamedPipeHandleState that follows it, so opening the pipe is
        // inside the retry too. Every control command is idempotent, so run
        // the whole exchange again rather than surfacing a reply the server
        // already sent.
        let result = send_once(&name, deadline).and_then(|pipe| exchange(pipe, command));
        match result {
            Ok(pid) => return Ok(pid),
            Err(error) if is_recycled_instance(&error) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
}

/// The server-side twin of [`is_recycled_instance`]: a read that failed
/// because no client is on the other end any more, whether it disconnected
/// or was never really there.
#[cfg(windows)]
fn is_gone_client(error: &std::io::Error) -> bool {
    use windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED;
    error.raw_os_error() == Some(ERROR_PIPE_NOT_CONNECTED as i32)
        || error.kind() == std::io::ErrorKind::BrokenPipe
}

#[cfg(windows)]
fn is_recycled_instance(error: &anyhow::Error) -> bool {
    use windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED;
    error.downcast_ref::<std::io::Error>().is_some_and(|io| {
        io.raw_os_error() == Some(ERROR_PIPE_NOT_CONNECTED as i32)
            || io.kind() == std::io::ErrorKind::BrokenPipe
    })
}

#[cfg(windows)]
fn send_once(name: &str, deadline: std::time::Instant) -> Result<std::fs::File> {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
    use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_READMODE_MESSAGE};

    let pipe = loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
        {
            Ok(pipe) => break pipe,
            Err(error)
                if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => return Err(error).with_context(|| format!("opening {name}")),
        }
    };
    let mode = PIPE_READMODE_MESSAGE;
    // SAFETY: `pipe` owns a live named-pipe handle and all optional pointers
    // are null. The mode pointer remains live for the duration of the call.
    if unsafe {
        SetNamedPipeHandleState(
            pipe.as_raw_handle().cast(),
            &mode,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("setting control pipe message mode");
    }
    Ok(pipe)
}

#[cfg(windows)]
fn exchange(mut pipe: std::fs::File, command: ControlCommand) -> Result<u32> {
    use std::io::{BufRead, Read, Write};

    let mut request = serde_json::to_vec(&ControlRequest { v: 1, command })?;
    request.push(b'\n');
    pipe.write_all(&request)?;
    pipe.flush()?;
    let mut response = Vec::with_capacity(256);
    // A successful named-pipe server disconnect is surfaced as BrokenPipe on
    // Windows, not as Unix-style EOF. The reply is already newline framed, so
    // stop at that boundary instead of waiting for the server to disconnect.
    let mut reader = std::io::BufReader::new(pipe.take((MAX_REQUEST_BYTES + 1) as u64));
    reader.read_until(b'\n', &mut response)?;
    if response.len() > MAX_REQUEST_BYTES {
        bail!("control reply is oversized");
    }
    if !response.ends_with(b"\n") {
        bail!("control reply is not newline terminated");
    }
    let reply: ControlReply =
        serde_json::from_slice(&response).context("decoding control reply")?;
    if reply.v != 1 || !reply.ok {
        bail!(
            "control request was rejected{}",
            reply
                .error
                .as_deref()
                .map(|error| format!(": {error}"))
                .unwrap_or_default()
        );
    }
    Ok(reply.pid)
}

#[cfg(not(windows))]
pub fn send(config_dir: &Path, command: ControlCommand) -> Result<u32> {
    let _ = (config_dir, command);
    bail!("Windows control pipes are unavailable on this platform")
}

pub fn ping(config_dir: &Path) -> Option<u32> {
    send(config_dir, ControlCommand::Ping).ok()
}

pub fn wait_for_ping(config_dir: &Path, timeout: std::time::Duration) -> Option<u32> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(pid) = ping(config_dir) {
            return Some(pid);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(windows)]
pub fn current_user_sid() -> Result<String> {
    use std::mem::size_of;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: output points to a valid HANDLE slot.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("opening the current process token");
    }
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns the token handle.
            unsafe { CloseHandle(self.0) };
        }
    }
    let token = Token(token);

    let mut needed = 0_u32;
    // SAFETY: the documented sizing call permits a null buffer and zero size.
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed);
    }
    if needed < size_of::<TOKEN_USER>() as u32 {
        bail!("Windows returned an invalid current-token SID size");
    }
    let words = (needed as usize).div_ceil(size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    // SAFETY: the usize-backed buffer is suitably aligned and `needed` bytes
    // long; TOKEN_USER contains a SID pointer valid while the buffer lives.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("reading the current user SID");
    }
    // SAFETY: GetTokenInformation initialized the aligned buffer as TOKEN_USER
    // and the referenced SID remains valid while buffer is live.
    let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut rendered = ptr::null_mut();
    // SAFETY: `user.User.Sid` is owned by the live token-information buffer.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut rendered) } == 0 {
        return Err(std::io::Error::last_os_error()).context("rendering the current user SID");
    }
    let mut length = 0_usize;
    // SAFETY: ConvertSidToStringSidW returned a NUL-terminated LocalAlloc string.
    unsafe {
        while *rendered.add(length) != 0 {
            length += 1;
        }
    }
    // SAFETY: the scan above established the initialized UTF-16 string length.
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(rendered, length) })
        .context("decoding the current user SID")?;
    // SAFETY: ConvertSidToStringSidW allocated this exact pointer.
    unsafe {
        LocalFree(rendered.cast());
    }
    Ok(sid)
}

#[cfg(windows)]
pub fn protect_path(path: &Path) -> Result<()> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR,
    };

    let sid = current_user_sid()?;
    let sddl = to_utf16(&format!("D:P(A;;FA;;;SY)(A;;FA;;;{sid})"));
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: sddl is NUL-terminated and descriptor receives LocalAlloc memory.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("building an owner-only file security descriptor");
    }
    let path = to_utf16(&path.display().to_string());
    // SAFETY: path and descriptor remain live and NUL-terminated for the call.
    let applied = unsafe {
        SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    // SAFETY: ConvertStringSecurityDescriptor allocated this exact pointer.
    unsafe {
        LocalFree(descriptor.cast());
    }
    if applied == 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("protecting {}", path_display(path.as_slice())));
    }
    Ok(())
}

#[cfg(windows)]
fn path_display(path: &[u16]) -> String {
    let end = path
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(path.len());
    String::from_utf16_lossy(&path[..end])
}

#[cfg(windows)]
fn to_utf16(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_sid_and_instance_pipe_names_do_not_collide() {
        let alice = pipe_name_for("S-1-5-21-1-1001", Path::new("/spawn/alice"));
        let bob = pipe_name_for("S-1-5-21-1-1002", Path::new("/spawn/alice"));
        let second = pipe_name_for("S-1-5-21-1-1001", Path::new("/spawn/second"));
        assert!(alice.starts_with(r"\\.\pipe\spawn-S-1-5-21-1-1001-"));
        assert!(alice.ends_with("-control"));
        assert_ne!(alice, bob);
        assert_ne!(alice, second);
    }

    #[test]
    fn protocol_accepts_only_one_bounded_versioned_command() {
        for (wire, expected) in [
            (
                b"{\"v\":1,\"command\":\"ping\"}\n".as_slice(),
                ControlCommand::Ping,
            ),
            (
                b"{\"v\":1,\"command\":\"reconnect\"}\n".as_slice(),
                ControlCommand::Reconnect,
            ),
            (
                b"{\"v\":1,\"command\":\"shutdown\"}\n".as_slice(),
                ControlCommand::Shutdown,
            ),
        ] {
            assert_eq!(decode_request(wire).unwrap(), expected);
        }
        assert!(decode_request(b"{\"v\":2,\"command\":\"ping\"}\n").is_err());
        assert!(decode_request(b"{\"v\":1,\"command\":\"unknown\"}\n").is_err());
        assert!(decode_request(br#"{"v":1,"command":"ping"}"#).is_err());
        assert!(decode_request(&vec![b'x'; MAX_REQUEST_BYTES + 1]).is_err());
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_control_pipe_ping_reads_the_framed_reply_before_disconnect() {
        let config = tempfile::tempdir().unwrap();
        let reconnect = Box::leak(Box::new(tokio::sync::Notify::new()));
        let shutdown = Box::leak(Box::new(tokio::sync::Notify::new()));
        start_listener(config.path(), reconnect, shutdown).unwrap();
        let path = config.path().to_path_buf();
        let pid = tokio::task::spawn_blocking(move || send(&path, ControlCommand::Ping))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pid, std::process::id());
    }
}
