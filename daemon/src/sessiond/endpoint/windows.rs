//! Windows named-pipe endpoint, reservation-handle transfer, and worker launch.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use uuid::Uuid;
use windows_sys::Win32::Foundation::{
    GetLastError, LocalFree, SetHandleInformation, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS,
    ERROR_FILE_EXISTS, ERROR_MORE_DATA, ERROR_PIPE_BUSY, ERROR_SHARING_VIOLATION, GENERIC_ALL,
    GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    EqualSid, GetAce, GetSecurityDescriptorControl, GetTokenInformation, TokenUser,
    ACCESS_ALLOWED_ACE, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileIdInfo,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, SetFileInformationByHandle,
    CREATE_NEW, DELETE, FILE_ALL_ACCESS, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
    FILE_NAME_NORMALIZED, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
    OPEN_EXISTING, READ_CONTROL, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
    InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken, TerminateProcess,
    UpdateProcThreadAttribute, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW,
    EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
};

use super::{Endpoint, LockAttempt};
use crate::sessiond::wire;

const PIPE_PREFIX: &str = r"\\.\pipe\spawn-";
const PIPE_NAME_UTF16_LIMIT: usize = 256;
const MAIN_PIPE_INSTANCES: usize = 4;
const LIFECYCLE_PIPE_INSTANCES: usize = 8;
const LIFECYCLE_HANDLER_SLOTS: usize = LIFECYCLE_PIPE_INSTANCES - 1;
const LIFECYCLE_READ_TIMEOUT: Duration = Duration::from_millis(100);
const RETRY_DELAY: Duration = Duration::from_millis(10);
const ACCESS_ALLOWED_ACE_KIND: u8 = 0;

#[derive(Clone, Debug)]
pub struct EndpointInner {
    dir: PathBuf,
    lock: PathBuf,
    marker: PathBuf,
    main_name: OsString,
    lifecycle_name: OsString,
}

impl EndpointInner {
    pub(super) fn new(dir: &Path, tag: &str, session_id: Uuid) -> Result<Self> {
        let user = current_user()?;
        let main_name = format!("{PIPE_PREFIX}{}{tag}-{session_id}", user.sid_string);
        let lifecycle_name = format!("{main_name}-lc");
        validate_pipe_name(&main_name, &user.sid_string, tag, session_id, false)?;
        validate_pipe_name(&lifecycle_name, &user.sid_string, tag, session_id, true)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            lock: dir.join(format!("{session_id}.lock")),
            marker: dir.join(format!("{session_id}.endpoint")),
            main_name: OsString::from(main_name),
            lifecycle_name: OsString::from(lifecycle_name),
        })
    }

    pub(super) fn main_arg(&self) -> &OsStr {
        &self.main_name
    }

    pub(super) fn lifecycle_arg(&self) -> &OsStr {
        &self.lifecycle_name
    }

    pub(super) fn metadata_dir(&self) -> &Path {
        &self.dir
    }
}

fn validate_pipe_name(
    name: &str,
    sid: &str,
    tag: &str,
    session_id: Uuid,
    lifecycle: bool,
) -> Result<()> {
    let expected = format!(
        "{PIPE_PREFIX}{sid}{tag}-{session_id}{}",
        if lifecycle { "-lc" } else { "" }
    );
    if name != expected
        || name[PIPE_PREFIX.len()..].contains('\\')
        || name.encode_utf16().count() > PIPE_NAME_UTF16_LIMIT
    {
        bail!("worker pipe name validation failed");
    }
    Ok(())
}

struct CurrentUser {
    token_user: Box<[usize]>,
    sid_string: String,
}

impl CurrentUser {
    fn sid(&self) -> PSID {
        // SAFETY: `token_user` was allocated with `usize` alignment, filled by
        // GetTokenInformation(TokenUser), and remains pinned in this OnceLock.
        unsafe { (*(self.token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    }
}

static CURRENT_USER: OnceLock<std::result::Result<CurrentUser, String>> = OnceLock::new();

fn current_user() -> Result<&'static CurrentUser> {
    match CURRENT_USER.get_or_init(|| load_current_user().map_err(|error| format!("{error:#}"))) {
        Ok(user) => Ok(user),
        Err(error) => bail!("current-user SID unavailable: {error}"),
    }
}

fn load_current_user() -> Result<CurrentUser> {
    let mut token = null_mut();
    // SAFETY: `token` is a valid out-pointer; the successful raw handle is
    // immediately wrapped below and never aliases another owner.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("opening current process token");
    }
    // SAFETY: OpenProcessToken returned one owned token handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };
    let token_user = query_token_user(raw_handle(&token))?;
    // SAFETY: the aligned TokenUser buffer remains live while conversion reads
    // its SID, and the returned string allocation is wrapped immediately.
    let sid_string = unsafe { sid_to_string(token_user_sid(&token_user)) }?;
    Ok(CurrentUser {
        token_user,
        sid_string,
    })
}

fn query_token_user(token: HANDLE) -> Result<Box<[usize]>> {
    let mut needed = 0u32;
    // SAFETY: the null first-call buffer is the documented size query; `needed`
    // is a valid out-pointer.
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed);
    }
    if needed < size_of::<TOKEN_USER>() as u32 {
        return Err(std::io::Error::last_os_error()).context("sizing token user information");
    }
    let words = (needed as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0usize; words].into_boxed_slice();
    // SAFETY: the allocation is `needed` bytes or larger, usize-aligned, and
    // remains live after the API initializes it.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("reading token user information");
    }
    Ok(storage)
}

fn token_user_sid(storage: &[usize]) -> PSID {
    // SAFETY: every caller passes aligned storage initialized by
    // GetTokenInformation(TokenUser) and keeps it live for the returned use.
    unsafe { (*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid }
}

/// # Safety
/// `sid` must remain a valid SID for the duration of the conversion call.
unsafe fn sid_to_string(sid: PSID) -> Result<String> {
    let mut raw = null_mut();
    // SAFETY: `sid` points into a live TokenUser allocation and `raw` is a
    // valid out-pointer for the LocalAlloc-owned string.
    if unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 {
        return Err(std::io::Error::last_os_error()).context("formatting current-user SID");
    }
    let allocation = LocalAllocation(raw.cast());
    let mut len = 0usize;
    // SAFETY: ConvertSidToStringSidW returned a NUL-terminated UTF-16 string;
    // scanning ends at that terminator while the allocation guard is live.
    unsafe {
        while *raw.add(len) != 0 {
            len += 1;
        }
    }
    // SAFETY: the preceding scan established exactly `len` initialized code
    // units before the terminator.
    let text = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) })
        .context("decoding current-user SID")?;
    drop(allocation);
    Ok(text)
}

struct LocalAllocation(*mut std::ffi::c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this guard exclusively owns a LocalAlloc allocation
            // returned by a Win32 conversion/security API.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct SecurityDescriptor {
    raw: PSECURITY_DESCRIPTOR,
}

impl SecurityDescriptor {
    fn current_user_only() -> Result<Self> {
        let sid = &current_user()?.sid_string;
        let sddl = format!("O:{sid}D:P(A;;GA;;;{sid})");
        let wide = wide(&sddl)?;
        let mut raw = null_mut();
        // SAFETY: `wide` is NUL-terminated and live for the call; `raw` is a
        // valid out-pointer whose LocalAlloc result enters this guard.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error())
                .context("building current-user security descriptor");
        }
        Ok(Self { raw })
    }

    fn attributes(&mut self, inheritable: bool) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.raw,
            bInheritHandle: i32::from(inheritable),
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            // SAFETY: ConvertStringSecurityDescriptor allocated this descriptor
            // with LocalAlloc and this guard is its sole owner.
            unsafe {
                LocalFree(self.raw.cast());
            }
        }
    }
}

pub fn ensure_private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating worker directory parent")?;
        }
        let path_wide = wide(path.as_os_str())?;
        let mut descriptor = SecurityDescriptor::current_user_only()?;
        let attributes = descriptor.attributes(false);
        // SAFETY: pathname and security descriptor remain live for the call.
        if unsafe { CreateDirectoryW(path_wide.as_ptr(), &attributes) } == 0 {
            // SAFETY: GetLastError has no pointer or lifetime requirements and
            // is read immediately on this thread after the failed call.
            let error = unsafe { GetLastError() };
            if error != ERROR_ALREADY_EXISTS {
                return Err(std::io::Error::from_raw_os_error(error as i32))
                    .context("creating protected worker directory");
            }
        }
    }
    let handle = open_path_handle(path, READ_CONTROL, true)?;
    validate_file_object(&handle, true).context("validating protected worker directory")
}

fn open_path_handle(path: &Path, access: u32, directory: bool) -> Result<OwnedHandle> {
    let path = wide(path.as_os_str())?;
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    // SAFETY: pathname is NUL-terminated and all optional pointers are null;
    // a successful raw handle is wrapped immediately.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    owned_handle(raw).context("opening worker metadata object")
}

fn validate_file_object(handle: &OwnedHandle, directory: bool) -> Result<()> {
    let attributes = file_attributes(handle)?;
    let is_directory = attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if is_directory != directory || attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("worker metadata object type validation failed");
    }
    validate_owner_dacl(raw_handle(handle))
}

fn file_attributes(handle: &OwnedHandle) -> Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: `info` is a correctly-sized writable output buffer and the
    // handle remains owned for the duration of the query.
    if unsafe {
        GetFileInformationByHandleEx(
            raw_handle(handle),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("reading worker metadata attributes");
    }
    Ok(info)
}

fn file_id(handle: &OwnedHandle) -> Result<FILE_ID_INFO> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: `info` is a correctly-sized writable output buffer and the
    // handle remains owned for the duration of the query.
    if unsafe {
        GetFileInformationByHandleEx(
            raw_handle(handle),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("reading worker metadata file id");
    }
    Ok(info)
}

fn validate_owner_dacl(handle: HANDLE) -> Result<()> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: every out-pointer is valid; on success `descriptor` owns the
    // storage containing `owner` and `dacl` and is guarded immediately.
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32))
            .context("reading worker metadata security");
    }
    let _allocation = LocalAllocation(descriptor.cast());
    let user = current_user()?;
    // SAFETY: `owner` and the current SID remain live for this comparison.
    if owner.is_null() || unsafe { EqualSid(owner, user.sid()) } == 0 {
        bail!("worker metadata owner validation failed");
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    // SAFETY: the descriptor remains live under `_allocation`; both output
    // pointers are valid.
    if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
    {
        bail!("worker metadata protected DACL validation failed");
    }
    if dacl.is_null() {
        bail!("worker metadata DACL validation failed");
    }
    // SAFETY: `dacl` points into the live descriptor returned by GetSecurityInfo.
    if unsafe { (*dacl).AceCount } != 1 {
        bail!("worker metadata DACL validation failed");
    }
    let mut raw_ace = null_mut();
    // SAFETY: the DACL is live and contains exactly one ACE; `raw_ace` is a
    // valid out-pointer.
    if unsafe { GetAce(dacl, 0, &mut raw_ace) } == 0 || raw_ace.is_null() {
        bail!("worker metadata DACL validation failed");
    }
    // SAFETY: GetAce returned an ACCESS_ALLOWED_ACE-sized entry after the type
    // check below; fields are read only while the descriptor is live.
    let ace = unsafe { &*(raw_ace.cast::<ACCESS_ALLOWED_ACE>()) };
    if ace.Header.AceType != ACCESS_ALLOWED_ACE_KIND
        || (ace.Mask != GENERIC_ALL && ace.Mask != FILE_ALL_ACCESS)
    {
        bail!("worker metadata DACL validation failed");
    }
    let ace_sid = std::ptr::addr_of!(ace.SidStart) as PSID;
    // SAFETY: the ACE SID and current-user SID remain live and valid.
    if unsafe { EqualSid(ace_sid, user.sid()) } == 0 {
        bail!("worker metadata DACL validation failed");
    }
    Ok(())
}

pub struct Reservation {
    handle: OwnedHandle,
    canonical_path: String,
    file_id: FILE_ID_INFO,
}

impl std::fmt::Debug for Reservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Reservation")
            .field("canonical_path", &self.canonical_path)
            .finish_non_exhaustive()
    }
}

pub type RawReservation = usize;

impl Reservation {
    pub fn raw_value(&self) -> usize {
        self.handle.as_raw_handle() as usize
    }
}

pub(super) fn try_reserve(endpoint: &Endpoint) -> Result<LockAttempt> {
    ensure_private_dir(&endpoint.inner.dir)?;
    let path = wide(endpoint.inner.lock.as_os_str())?;
    let mut descriptor = SecurityDescriptor::current_user_only()?;
    let attributes = descriptor.attributes(false);
    // SAFETY: pathname and descriptor remain live; share mode zero deliberately
    // creates the cross-process exclusive reservation object.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            0,
            &attributes,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        // SAFETY: GetLastError has no pointer or lifetime requirements and is
        // read immediately on this thread after the failed CreateFileW.
        let error = unsafe { GetLastError() };
        if error == ERROR_SHARING_VIOLATION {
            return Ok(LockAttempt::Busy);
        }
        return Err(std::io::Error::from_raw_os_error(error as i32))
            .context("opening worker endpoint reservation");
    }
    // SAFETY: CreateFileW returned one owned handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    let reservation = validate_reservation(handle, endpoint)?;
    Ok(LockAttempt::Acquired(reservation))
}

/// # Safety
/// `raw` must be the inherited owned reservation handle for this worker.
pub(super) unsafe fn adopt_reservation(
    raw: RawReservation,
    endpoint: &Endpoint,
) -> Result<Reservation> {
    if raw == 0 || raw as HANDLE == INVALID_HANDLE_VALUE {
        bail!("worker reservation handle validation failed");
    }
    // SAFETY: the caller transfers the inherited HANDLE's sole Rust ownership.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    // SAFETY: the handle is live; clearing inheritance cannot invalidate it.
    if unsafe { SetHandleInformation(raw_handle(&handle), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(std::io::Error::last_os_error())
            .context("clearing worker reservation inheritance");
    }
    validate_reservation(handle, endpoint)
}

fn validate_reservation(handle: OwnedHandle, endpoint: &Endpoint) -> Result<Reservation> {
    validate_file_object(&handle, false).context("validating worker endpoint reservation")?;
    let canonical_path = final_path(&handle)?;
    let expected = canonical_expected_path(&endpoint.inner.lock)?;
    if normalize_windows_path(&canonical_path) != normalize_windows_path(&expected) {
        bail!("worker reservation identity validation failed");
    }
    let file_id = file_id(&handle)?;
    Ok(Reservation {
        handle,
        canonical_path,
        file_id,
    })
}

fn final_path(handle: &OwnedHandle) -> Result<String> {
    // SAFETY: null buffer/zero length is the documented size query and handle
    // remains valid.
    let needed = unsafe {
        GetFinalPathNameByHandleW(
            raw_handle(handle),
            null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if needed == 0 {
        return Err(std::io::Error::last_os_error()).context("sizing reservation final path");
    }
    let mut buffer = vec![0u16; needed as usize + 1];
    // SAFETY: buffer is at least the size reported above and remains live.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            raw_handle(handle),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(std::io::Error::last_os_error()).context("reading reservation final path");
    }
    String::from_utf16(&buffer[..written as usize]).context("decoding reservation final path")
}

fn canonical_expected_path(path: &Path) -> Result<String> {
    let parent = path.parent().context("reservation path has no parent")?;
    let canonical_parent =
        std::fs::canonicalize(parent).context("canonicalizing reservation parent")?;
    Ok(canonical_parent
        .join(path.file_name().context("reservation path has no leaf")?)
        .to_string_lossy()
        .into_owned())
}

fn normalize_windows_path(path: &str) -> String {
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| path.to_owned());
    path.replace('/', "\\").to_lowercase()
}

#[derive(Serialize, Deserialize)]
struct Marker {
    version: u8,
    session_id: Uuid,
    instance_id: Uuid,
    main_name: String,
}

pub struct EndpointIdentitySet {
    marker: EndpointIdentity,
}

impl EndpointIdentitySet {
    pub fn cleanup(&self) -> Result<()> {
        self.marker.cleanup().map(|_| ())
    }
}

impl Drop for EndpointIdentitySet {
    fn drop(&mut self) {
        let _ = self.marker.cleanup();
    }
}

struct EndpointIdentity {
    path: PathBuf,
    file_id: FILE_ID_INFO,
}

impl EndpointIdentity {
    fn cleanup(&self) -> Result<bool> {
        let handle = match open_path_handle(&self.path, DELETE | READ_CONTROL, false) {
            Ok(handle) => handle,
            Err(error) if is_not_found(&error) => return Ok(false),
            Err(error) => return Err(error).context("opening endpoint marker for cleanup"),
        };
        validate_file_object(&handle, false)?;
        if !same_file_id(&file_id(&handle)?, &self.file_id) {
            return Ok(false);
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: `disposition` has the exact Win32 layout/size and the handle
        // designates the marker object whose stable file ID was just checked.
        if unsafe {
            SetFileInformationByHandle(
                raw_handle(&handle),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error()).context("deleting endpoint marker");
        }
        Ok(true)
    }
}

fn same_file_id(left: &FILE_ID_INFO, right: &FILE_ID_INFO) -> bool {
    left.VolumeSerialNumber == right.VolumeSerialNumber
        && left.FileId.Identifier == right.FileId.Identifier
}

pub(super) fn remove_stale(endpoint: &Endpoint, held: &Reservation) -> Result<()> {
    let expected = canonical_expected_path(&endpoint.inner.lock)?;
    if normalize_windows_path(&held.canonical_path) != normalize_windows_path(&expected)
        || held.file_id.FileId.Identifier == [0; 16]
    {
        bail!("worker reservation identity validation failed");
    }
    let marker = match open_marker(endpoint) {
        Ok((_, identity)) => identity,
        Err(error) if is_not_found(&error) => return Ok(()),
        Err(error) => return Err(error).context("inspecting stale endpoint marker"),
    };
    marker.cleanup()?;
    Ok(())
}

fn create_marker(endpoint: &Endpoint, instance_id: Uuid) -> Result<EndpointIdentity> {
    let path = wide(endpoint.inner.marker.as_os_str())?;
    let mut descriptor = SecurityDescriptor::current_user_only()?;
    let attributes = descriptor.attributes(false);
    // SAFETY: pathname/security attributes remain live and CREATE_NEW avoids
    // replacing an untrusted or concurrently-created marker.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        // SAFETY: GetLastError has no pointer or lifetime requirements and is
        // read immediately on this thread after the failed CreateFileW.
        let error = unsafe { GetLastError() };
        let message = if error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS {
            "worker endpoint marker already exists"
        } else {
            "creating worker endpoint marker"
        };
        return Err(std::io::Error::from_raw_os_error(error as i32)).context(message);
    }
    // SAFETY: CreateFileW returned one owned marker handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    validate_file_object(&handle, false)?;
    let identity = EndpointIdentity {
        path: endpoint.inner.marker.clone(),
        file_id: file_id(&handle)?,
    };
    let marker = Marker {
        version: 1,
        session_id: endpoint.session_id,
        instance_id,
        main_name: endpoint.inner.main_name.to_string_lossy().into_owned(),
    };
    let mut file: File = handle.into();
    let write_result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, &marker).context("serializing endpoint marker")?;
        file.write_all(b"\n").context("writing endpoint marker")?;
        file.sync_all().context("flushing endpoint marker")
    })();
    drop(file);
    if let Err(error) = write_result {
        let _ = identity.cleanup();
        return Err(error);
    }
    Ok(identity)
}

fn open_marker(endpoint: &Endpoint) -> Result<(Marker, EndpointIdentity)> {
    let handle = open_path_handle(&endpoint.inner.marker, GENERIC_READ | READ_CONTROL, false)?;
    validate_file_object(&handle, false)?;
    let identity = EndpointIdentity {
        path: endpoint.inner.marker.clone(),
        file_id: file_id(&handle)?,
    };
    let mut file: File = handle.into();
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .context("reading endpoint marker")?;
    let marker: Marker = serde_json::from_slice(&bytes).context("decoding endpoint marker")?;
    if marker.version != 1
        || marker.session_id != endpoint.session_id
        || marker.main_name != endpoint.inner.main_name.to_string_lossy()
    {
        bail!("worker endpoint marker validation failed");
    }
    Ok((marker, identity))
}

pub struct MainListener {
    next: Option<NamedPipeServer>,
    name: OsString,
}

pub type WorkerSideStream = NamedPipeServer;
pub type SupervisorSideStream = NamedPipeClient;
pub type WorkerReadHalf = ReadHalf<NamedPipeServer>;
pub type WorkerWriteHalf = WriteHalf<NamedPipeServer>;
pub type SupervisorReadHalf = ReadHalf<NamedPipeClient>;
pub type SupervisorWriteHalf = WriteHalf<NamedPipeClient>;

pub struct LifecycleListener {
    receiver: mpsc::Receiver<LifecycleExchange>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for LifecycleListener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub struct LifecycleExchange {
    server: NamedPipeServer,
    request: [u8; wire::LIFECYCLE_REQUEST_LEN + 1],
    len: usize,
    _permit: OwnedSemaphorePermit,
}

impl LifecycleExchange {
    pub fn request(&self) -> (&[u8], usize) {
        (&self.request[..self.len], self.len)
    }
}

pub struct BoundWorkerEndpoints {
    pub main: MainListener,
    pub lifecycle: LifecycleListener,
    pub identity: EndpointIdentitySet,
}

pub(super) fn bind_worker(
    endpoint: &Endpoint,
    _held: &Reservation,
    instance_id: Uuid,
) -> Result<BoundWorkerEndpoints> {
    let main_server = create_pipe(
        endpoint.inner.main_name.as_os_str(),
        PipeMode::Byte,
        MAIN_PIPE_INSTANCES,
        true,
    )?;
    let lifecycle_server = create_pipe(
        endpoint.inner.lifecycle_name.as_os_str(),
        PipeMode::Message,
        LIFECYCLE_PIPE_INSTANCES,
        true,
    )?;
    let marker = create_marker(endpoint, instance_id)?;
    let main = MainListener {
        next: Some(main_server),
        name: endpoint.inner.main_name.clone(),
    };
    let lifecycle =
        start_lifecycle_listener(endpoint.inner.lifecycle_name.clone(), lifecycle_server);
    Ok(BoundWorkerEndpoints {
        main,
        lifecycle,
        identity: EndpointIdentitySet { marker },
    })
}

fn create_pipe(
    name: &OsStr,
    mode: PipeMode,
    max_instances: usize,
    first: bool,
) -> Result<NamedPipeServer> {
    let mut descriptor = SecurityDescriptor::current_user_only()?;
    let mut attributes = descriptor.attributes(false);
    let mut options = ServerOptions::new();
    options
        .pipe_mode(mode)
        .reject_remote_clients(true)
        .max_instances(max_instances)
        .first_pipe_instance(first);
    if mode == PipeMode::Message {
        options
            .in_buffer_size(wire::LIFECYCLE_REQUEST_LEN as u32)
            .out_buffer_size(1);
    }
    // SAFETY: the security descriptor and attributes remain valid through the
    // synchronous CreateNamedPipeW call; Tokio takes ownership only of HANDLE.
    unsafe {
        options.create_with_security_attributes_raw(
            name,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
    .context("creating protected worker named pipe")
}

pub(super) async fn accept_main(listener: &mut MainListener) -> Result<WorkerSideStream> {
    let server = listener
        .next
        .take()
        .context("worker main listener is unavailable")?;
    server
        .connect()
        .await
        .context("accepting named-pipe connection")?;
    let replacement = create_pipe(&listener.name, PipeMode::Byte, MAIN_PIPE_INSTANCES, false)?;
    listener.next = Some(replacement);
    Ok(server)
}

fn start_lifecycle_listener(name: OsString, first: NamedPipeServer) -> LifecycleListener {
    let (sender, receiver) = mpsc::channel(LIFECYCLE_HANDLER_SLOTS);
    let task = tokio::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(LIFECYCLE_HANDLER_SLOTS));
        let mut next = first;
        loop {
            let Ok(permit) = Arc::clone(&semaphore).acquire_owned().await else {
                break;
            };
            if next.connect().await.is_err() || validate_worker_peer(&next).is_err() {
                match create_pipe(&name, PipeMode::Message, LIFECYCLE_PIPE_INSTANCES, false) {
                    Ok(replacement) => next = replacement,
                    Err(_) => break,
                }
                continue;
            }
            let connected = next;
            next = match create_pipe(&name, PipeMode::Message, LIFECYCLE_PIPE_INSTANCES, false) {
                Ok(replacement) => replacement,
                Err(_) => break,
            };
            let exchange_sender = sender.clone();
            tokio::spawn(async move {
                let mut server = connected;
                let mut request = [0u8; wire::LIFECYCLE_REQUEST_LEN + 1];
                let read =
                    tokio::time::timeout(LIFECYCLE_READ_TIMEOUT, server.read(&mut request)).await;
                let len = match read {
                    Ok(Ok(len)) => len,
                    // A message longer than our deliberately one-byte-oversized
                    // buffer is complete but malformed. Preserve that fact for
                    // the shared decoder instead of silently dropping it.
                    Ok(Err(error)) if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) => {
                        request.len()
                    }
                    _ => return,
                };
                let exchange = LifecycleExchange {
                    server,
                    request,
                    len,
                    _permit: permit,
                };
                let _ = exchange_sender.send(exchange).await;
            });
        }
    });
    LifecycleListener { receiver, task }
}

pub(super) async fn receive_lifecycle(
    listener: &mut LifecycleListener,
) -> Result<LifecycleExchange> {
    listener
        .receiver
        .recv()
        .await
        .context("worker lifecycle named-pipe listener stopped")
}

pub(super) async fn acknowledge_lifecycle(
    _listener: &mut LifecycleListener,
    mut exchange: LifecycleExchange,
    ack: u8,
) -> Result<()> {
    exchange
        .server
        .write_all(&[ack])
        .await
        .context("writing lifecycle acknowledgement")?;
    exchange
        .server
        .flush()
        .await
        .context("flushing lifecycle acknowledgement")
}

pub(super) async fn connect_main(
    endpoint: &Endpoint,
    deadline: Instant,
) -> Result<SupervisorSideStream> {
    open_pipe_with_retry(endpoint, PipeMode::Byte, deadline).await
}

async fn open_pipe_with_retry(
    endpoint: &Endpoint,
    mode: PipeMode,
    deadline: Instant,
) -> Result<NamedPipeClient> {
    let name = if mode == PipeMode::Byte {
        endpoint.inner.main_name.as_os_str()
    } else {
        endpoint.inner.lifecycle_name.as_os_str()
    };
    loop {
        match open_marker(endpoint) {
            Ok(_) => {}
            Err(error) if is_not_found(&error) && Instant::now() < deadline => {
                tokio::time::sleep_until(std::cmp::min(deadline, Instant::now() + RETRY_DELAY))
                    .await;
                continue;
            }
            Err(error) if is_not_found(&error) => bail!("worker endpoint unreachable"),
            Err(error) => return Err(error).context("validating worker endpoint marker"),
        }
        match ClientOptions::new().pipe_mode(mode).open(name) {
            Ok(client) => {
                validate_supervisor_peer(&client)?;
                return Ok(client);
            }
            Err(error)
                if (error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32))
                    && Instant::now() < deadline =>
            {
                tokio::time::sleep_until(std::cmp::min(deadline, Instant::now() + RETRY_DELAY))
                    .await;
            }
            Err(_) if Instant::now() >= deadline => bail!("worker endpoint unreachable"),
            Err(error) => return Err(error).context("opening worker named pipe"),
        }
    }
}

pub(super) fn split_worker(stream: WorkerSideStream) -> (WorkerReadHalf, WorkerWriteHalf) {
    tokio::io::split(stream)
}

pub(super) fn split_supervisor(
    stream: SupervisorSideStream,
) -> (SupervisorReadHalf, SupervisorWriteHalf) {
    tokio::io::split(stream)
}

pub(super) fn validate_worker_peer(stream: &WorkerSideStream) -> Result<()> {
    let mut pid = 0u32;
    // SAFETY: the server HANDLE remains live and `pid` is a valid out-pointer.
    if unsafe { GetNamedPipeClientProcessId(raw_pipe_handle(stream), &mut pid) } == 0 {
        return Err(std::io::Error::last_os_error()).context("reading named-pipe client process");
    }
    validate_process_user(pid)
}

pub(super) fn validate_supervisor_peer(stream: &SupervisorSideStream) -> Result<()> {
    let mut pid = 0u32;
    // SAFETY: the client HANDLE remains live and `pid` is a valid out-pointer.
    if unsafe { GetNamedPipeServerProcessId(raw_pipe_handle(stream), &mut pid) } == 0 {
        return Err(std::io::Error::last_os_error()).context("reading named-pipe server process");
    }
    validate_process_user(pid)
}

fn validate_process_user(pid: u32) -> Result<()> {
    // SAFETY: OpenProcess returns a new owned handle or null; no borrowed
    // handles are transferred.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(std::io::Error::last_os_error()).context("opening named-pipe peer process");
    }
    // SAFETY: OpenProcess returned one owned process handle.
    let process = unsafe { OwnedHandle::from_raw_handle(process as RawHandle) };
    let mut token = null_mut();
    // SAFETY: the process handle remains live and `token` is a valid out-pointer.
    if unsafe { OpenProcessToken(raw_handle(&process), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("opening named-pipe peer token");
    }
    // SAFETY: OpenProcessToken returned one owned token handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token as RawHandle) };
    let peer = query_token_user(raw_handle(&token))?;
    // SAFETY: both SID buffers remain live for the duration of EqualSid.
    if unsafe { EqualSid(token_user_sid(&peer), current_user()?.sid()) } == 0 {
        bail!("worker peer ownership validation failed");
    }
    Ok(())
}

pub(super) fn endpoint_exists(endpoint: &Endpoint) -> bool {
    open_marker(endpoint).is_ok()
}

pub(super) fn discover_ids(dir: &Path, tag: &str) -> Vec<Uuid> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let id = Uuid::parse_str(name.strip_suffix(".endpoint")?).ok()?;
            let endpoint = super::endpoint_for(dir, tag, id).ok()?;
            endpoint_exists(&endpoint).then_some(id)
        })
        .collect()
}

pub(super) async fn send_lifecycle(
    endpoint: &Endpoint,
    request: &[u8; wire::LIFECYCLE_REQUEST_LEN],
    deadline: Instant,
) -> Result<u8> {
    loop {
        if Instant::now() >= deadline {
            bail!("worker lifecycle delivery deadline exceeded");
        }
        let mut client = match open_pipe_with_retry(endpoint, PipeMode::Message, deadline).await {
            Ok(client) => client,
            Err(error) if Instant::now() >= deadline => {
                let _ = error;
                bail!("worker lifecycle delivery deadline exceeded")
            }
            Err(error) => return Err(error),
        };
        let attempt = async {
            client.write_all(request).await?;
            client.flush().await?;
            let mut ack = [0u8; 2];
            let len = client.read(&mut ack).await?;
            if len != 1 {
                bail!("worker lifecycle acknowledgement was malformed");
            }
            Ok::<u8, anyhow::Error>(ack[0])
        };
        match tokio::time::timeout_at(deadline, attempt).await {
            Ok(Ok(ack)) => return Ok(ack),
            Ok(Err(_)) if Instant::now() < deadline => {
                tokio::time::sleep_until(std::cmp::min(deadline, Instant::now() + RETRY_DELAY))
                    .await;
            }
            _ => bail!("worker lifecycle delivery deadline exceeded"),
        }
    }
}

pub struct SpawnedWorker {
    pub pid: u32,
    _process: OwnedHandle,
}

pub fn spawn_worker(
    bin: &Path,
    args: &[OsString],
    reservation: &Reservation,
) -> Result<SpawnedWorker> {
    let executable = resolve_executable(bin)?;
    let executable_wide = wide(executable.as_os_str())?;
    let mut command_line = windows_command_line(executable.as_os_str(), args)?;

    let mut inherit_descriptor = SecurityDescriptor::current_user_only()?;
    let inherit_attributes = inherit_descriptor.attributes(true);
    let nul = wide(OsStr::new("NUL"))?;
    let nul_in = create_nul(&nul, GENERIC_READ, &inherit_attributes)?;
    let nul_out = create_nul(&nul, GENERIC_WRITE, &inherit_attributes)?;
    let nul_err = create_nul(&nul, GENERIC_WRITE, &inherit_attributes)?;

    // SAFETY: the reservation handle is live. It is reset immediately after
    // CreateProcessW, and the explicit HANDLE_LIST limits this child to the
    // four handles below.
    if unsafe {
        SetHandleInformation(
            raw_handle(&reservation.handle),
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("making worker reservation inheritable");
    }
    let reset_inherit = InheritReset(raw_handle(&reservation.handle));

    let handles = [
        raw_handle(&reservation.handle),
        raw_handle(&nul_in),
        raw_handle(&nul_out),
        raw_handle(&nul_err),
    ];
    let mut attribute_bytes = 0usize;
    // SAFETY: null first call is the documented attribute-list size query.
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
    }
    if attribute_bytes == 0 {
        return Err(std::io::Error::last_os_error()).context("sizing worker handle list");
    }
    let mut attribute_storage =
        vec![0usize; attribute_bytes.div_ceil(size_of::<usize>())].into_boxed_slice();
    let attribute_list = attribute_storage.as_mut_ptr().cast();
    // SAFETY: storage is aligned and at least the size returned by the query.
    if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) } == 0
    {
        return Err(std::io::Error::last_os_error()).context("initializing worker handle list");
    }
    let attribute_guard = AttributeList(attribute_list);
    // SAFETY: `handles` remains live through CreateProcessW and contains only
    // inheritable, owned HANDLE values.
    if unsafe {
        UpdateProcThreadAttribute(
            attribute_list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of::<HANDLE>() * handles.len(),
            null_mut(),
            null(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("installing worker handle list");
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw_handle(&nul_in);
    startup.StartupInfo.hStdOutput = raw_handle(&nul_out);
    startup.StartupInfo.hStdError = raw_handle(&nul_err);
    startup.lpAttributeList = attribute_list;
    let mut process = PROCESS_INFORMATION::default();
    let flags = CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT;
    // SAFETY: application/command-line buffers and STARTUPINFOEX (including
    // its handle list) remain live and writable for the complete call.
    let created = unsafe {
        CreateProcessW(
            executable_wide.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags,
            null(),
            null(),
            (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
            &mut process,
        )
    };
    drop(attribute_guard);
    drop(reset_inherit);
    if created == 0 {
        let error = std::io::Error::last_os_error();
        let context = if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
            "worker breakaway launch was denied"
        } else {
            "worker detached breakaway launch failed"
        };
        return Err(error).context(context);
    }
    // SAFETY: CreateProcessW returned two independent owned handles.
    let process_handle = unsafe { OwnedHandle::from_raw_handle(process.hProcess as RawHandle) };
    // SAFETY: the primary thread handle is not needed after creation and has
    // exactly one owner here.
    drop(unsafe { OwnedHandle::from_raw_handle(process.hThread as RawHandle) });
    let mut in_job = 0;
    // SAFETY: the child process handle is live, NULL asks whether it belongs
    // to any job, and `in_job` is a valid BOOL out-pointer.
    if unsafe { IsProcessInJob(raw_handle(&process_handle), null_mut(), &mut in_job) } == 0 {
        let error = std::io::Error::last_os_error();
        // SAFETY: this live child has not been published; terminating it is
        // required because its breakaway status could not be established.
        unsafe { TerminateProcess(raw_handle(&process_handle), 1) };
        return Err(error).context("verifying worker job breakaway");
    }
    if in_job != 0 {
        // SAFETY: this live child has not been published and retaining a
        // supervisor-job member would violate the restart-survival contract.
        unsafe { TerminateProcess(raw_handle(&process_handle), 1) };
        bail!("worker launch remained inside the supervisor job");
    }
    Ok(SpawnedWorker {
        pid: process.dwProcessId,
        _process: process_handle,
    })
}

struct AttributeList(*mut std::ffi::c_void);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: this pointer was successfully initialized once and remains
        // backed by live storage until after this guard drops.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

struct InheritReset(HANDLE);

impl Drop for InheritReset {
    fn drop(&mut self) {
        // SAFETY: the reservation handle remains live in its owner while this
        // guard clears only HANDLE_FLAG_INHERIT.
        unsafe {
            SetHandleInformation(self.0, HANDLE_FLAG_INHERIT, 0);
        }
    }
}

fn create_nul(nul: &[u16], access: u32, attributes: &SECURITY_ATTRIBUTES) -> Result<OwnedHandle> {
    // SAFETY: `nul` and attributes remain live; the returned handle enters an
    // owner immediately.
    let raw = unsafe {
        CreateFileW(
            nul.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            attributes,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    owned_handle(raw).context("opening inheritable NUL handle")
}

fn resolve_executable(bin: &Path) -> Result<PathBuf> {
    if bin.is_absolute() || bin.components().count() > 1 {
        return std::fs::canonicalize(bin).context("resolving worker executable");
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(bin);
            if candidate.is_file() {
                return std::fs::canonicalize(candidate).context("resolving worker executable");
            }
        }
    }
    bail!("worker executable was not found")
}

fn windows_command_line(program: &OsStr, args: &[OsString]) -> Result<Vec<u16>> {
    let mut command = Vec::new();
    append_windows_arg(&mut command, program, true)?;
    for arg in args {
        command.push(' ' as u16);
        append_windows_arg(&mut command, arg, false)?;
    }
    command.push(0);
    Ok(command)
}

fn append_windows_arg(command: &mut Vec<u16>, arg: &OsStr, force_quote: bool) -> Result<()> {
    let encoded: Vec<u16> = arg.encode_wide().collect();
    if encoded.contains(&0) {
        bail!("worker argument contains NUL");
    }
    let quote = force_quote
        || encoded.is_empty()
        || encoded
            .iter()
            .any(|unit| *unit == ' ' as u16 || *unit == '\t' as u16);
    if quote {
        command.push('"' as u16);
    }
    let mut backslashes = 0usize;
    for unit in encoded {
        if unit == '\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == '"' as u16 {
            command.extend(std::iter::repeat_n('\\' as u16, backslashes * 2 + 1));
        } else {
            command.extend(std::iter::repeat_n('\\' as u16, backslashes));
        }
        backslashes = 0;
        command.push(unit);
    }
    if quote {
        command.extend(std::iter::repeat_n('\\' as u16, backslashes * 2));
        command.push('"' as u16);
    } else {
        command.extend(std::iter::repeat_n('\\' as u16, backslashes));
    }
    Ok(())
}

#[derive(Clone)]
pub struct WorkerJob {
    handle: Arc<OwnedHandle>,
}

pub fn create_worker_job() -> Result<WorkerJob> {
    // SAFETY: null security/name pointers request one unnamed Job Object; the
    // returned handle enters an owner immediately.
    let raw = unsafe { CreateJobObjectW(null(), null()) };
    let handle = owned_handle(raw).context("creating worker process-tree job")?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` has the exact structure/size required for this info
    // class and the job handle remains live.
    if unsafe {
        SetInformationJobObject(
            raw_handle(&handle),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("configuring worker process-tree job");
    }
    // SAFETY: both handles remain live; the detached worker successfully
    // broke away before assigning itself to its own job.
    if unsafe { AssignProcessToJobObject(raw_handle(&handle), GetCurrentProcess()) } == 0 {
        return Err(std::io::Error::last_os_error()).context("assigning worker process-tree job");
    }
    Ok(WorkerJob {
        handle: Arc::new(handle),
    })
}

impl WorkerJob {
    pub fn terminate(&self) -> Result<()> {
        // SAFETY: the job handle remains live; termination intentionally
        // includes the calling worker and every descendant in the job.
        if unsafe { TerminateJobObject(raw_handle(&self.handle), 1) } == 0 {
            return Err(std::io::Error::last_os_error()).context("terminating worker process tree");
        }
        Ok(())
    }
}

pub fn open_worker_log(log_dir: &Path) -> Result<File> {
    ensure_private_dir(log_dir)?;
    let path = log_dir.join("worker.log");
    let path_wide = wide(path.as_os_str())?;
    let mut descriptor = SecurityDescriptor::current_user_only()?;
    let attributes = descriptor.attributes(false);
    // SAFETY: pathname/security descriptor remain live; sharing delete lets
    // scrollback teardown remove the directory while the log handle drains.
    let raw = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            FILE_APPEND_DATA | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    let handle = owned_handle(raw).context("opening protected worker log")?;
    validate_file_object(&handle, false)?;
    let mut file: File = handle.into();
    file.seek(SeekFrom::End(0)).context("seeking worker log")?;
    Ok(file)
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn raw_pipe_handle<T: AsRawHandle>(pipe: &T) -> HANDLE {
    pipe.as_raw_handle() as HANDLE
}

fn owned_handle(raw: HANDLE) -> Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error()).context("Win32 handle creation failed");
    }
    // SAFETY: callers pass a newly-created, unowned raw HANDLE exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) })
}

fn wide(value: impl AsRef<OsStr>) -> Result<Vec<u16>> {
    let mut wide: Vec<u16> = value.as_ref().encode_wide().collect();
    if wide.contains(&0) {
        bail!("Windows path or name contains NUL");
    }
    wide.push(0);
    Ok(wide)
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protected_tempdir() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let protected = temp.path().join("workers");
        ensure_private_dir(&protected).unwrap();
        (temp, protected)
    }

    async fn open_test_client(name: &OsStr, mode: PipeMode) -> NamedPipeClient {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match ClientOptions::new().pipe_mode(mode).open(name) {
                Ok(client) => return client,
                Err(error)
                    if (error.kind() == std::io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32))
                        && Instant::now() < deadline =>
                {
                    tokio::time::sleep(RETRY_DELAY).await;
                }
                Err(error) => panic!("opening test named pipe failed: {error}"),
            }
        }
    }

    #[test]
    fn flat_pipe_names_are_deterministic_and_tagged() {
        let (_temp, dir) = protected_tempdir();
        let id = Uuid::nil();
        let default = super::super::endpoint_for(&dir, "", id).unwrap();
        let tagged = super::super::endpoint_for(&dir, "-89abcdef", id).unwrap();
        let default = default.main_arg().to_string_lossy();
        let tagged = tagged.main_arg().to_string_lossy();
        assert!(default.starts_with(r"\\.\pipe\spawn-S-"));
        assert!(!default[PIPE_PREFIX.len()..].contains('\\'));
        assert!(tagged.contains("-89abcdef-00000000-0000-0000-0000-000000000000"));
    }

    #[test]
    fn pipe_name_limit_rejects_an_overlong_flat_name() {
        let sid = format!("S-{}", "1".repeat(PIPE_NAME_UTF16_LIMIT));
        let id = Uuid::nil();
        let name = format!("{PIPE_PREFIX}{sid}-{id}");
        assert!(validate_pipe_name(&name, &sid, "", id, false).is_err());
    }

    #[test]
    fn reservation_is_exclusive_until_every_handle_closes() {
        let (_temp, dir) = protected_tempdir();
        let endpoint = super::super::endpoint_for(&dir, "", Uuid::new_v4()).unwrap();
        let first = match try_reserve(&endpoint).unwrap() {
            LockAttempt::Acquired(reservation) => reservation,
            LockAttempt::Busy => panic!("first reservation was busy"),
        };
        assert!(matches!(try_reserve(&endpoint).unwrap(), LockAttempt::Busy));
        drop(first);
        assert!(matches!(
            try_reserve(&endpoint).unwrap(),
            LockAttempt::Acquired(_)
        ));
    }

    #[test]
    fn worker_command_line_quotes_spaces_and_backslashes() {
        let line = windows_command_line(
            OsStr::new(r"C:\Program Files\SPAWN D\spawn-worker.exe"),
            &[
                OsString::from("plain"),
                OsString::from("two words"),
                OsString::from(r#"quote\"inside"#),
            ],
        )
        .unwrap();
        let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert!(text.starts_with(r#""C:\Program Files\SPAWN D\spawn-worker.exe" plain "#));
        assert!(text.contains(r#""two words""#));
        assert!(text.contains(r#"quote\\\"inside"#));
    }

    #[tokio::test]
    async fn main_pipe_is_exclusive_rolls_and_validates_both_peers() {
        let (_temp, dir) = protected_tempdir();
        let endpoint = super::super::endpoint_for(&dir, "", Uuid::new_v4()).unwrap();
        let name = endpoint.inner.main_name.clone();
        let first = create_pipe(&name, PipeMode::Byte, MAIN_PIPE_INSTANCES, true).unwrap();
        assert!(create_pipe(&name, PipeMode::Byte, MAIN_PIPE_INSTANCES, true).is_err());
        let mut listener = MainListener {
            next: Some(first),
            name: name.clone(),
        };
        let mut client = open_test_client(&name, PipeMode::Byte).await;
        let mut server = accept_main(&mut listener).await.unwrap();
        validate_worker_peer(&server).unwrap();
        validate_supervisor_peer(&client).unwrap();

        wire::write_frame(&mut client, wire::T_REDRAW, b"roll")
            .await
            .unwrap();
        let (frame_type, payload) = wire::read_frame(&mut server).await.unwrap().unwrap();
        assert_eq!(frame_type, wire::T_REDRAW);
        assert_eq!(payload, b"roll");

        drop(client);
        drop(server);
        drop(listener);
        create_pipe(&name, PipeMode::Byte, MAIN_PIPE_INSTANCES, true).unwrap();
    }

    #[tokio::test]
    async fn silent_lifecycle_clients_are_bounded_and_expire_for_a_valid_request() {
        let (_temp, dir) = protected_tempdir();
        let endpoint = super::super::endpoint_for(&dir, "", Uuid::new_v4()).unwrap();
        let reservation = match try_reserve(&endpoint).unwrap() {
            LockAttempt::Acquired(reservation) => reservation,
            LockAttempt::Busy => panic!("new lifecycle reservation was busy"),
        };
        let BoundWorkerEndpoints {
            main: _main,
            mut lifecycle,
            identity: _identity,
        } = bind_worker(&endpoint, &reservation, Uuid::new_v4()).unwrap();

        let mut silent = Vec::new();
        for _ in 0..LIFECYCLE_HANDLER_SLOTS {
            silent.push(open_test_client(endpoint.lifecycle_arg(), PipeMode::Message).await);
            tokio::task::yield_now().await;
        }

        let instance = Uuid::new_v4();
        let request = wire::encode_lifecycle_request(instance, wire::LifecycleSignal::Kill);
        let responder = tokio::spawn(async move {
            let exchange = receive_lifecycle(&mut lifecycle).await.unwrap();
            let (received, len) = exchange.request();
            assert_eq!(len, request.len());
            assert_eq!(received, request);
            acknowledge_lifecycle(&mut lifecycle, exchange, wire::LIFECYCLE_ACK_DELIVERED)
                .await
                .unwrap();
        });
        let started = Instant::now();
        let ack = send_lifecycle(&endpoint, &request, Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(ack, wire::LIFECYCLE_ACK_DELIVERED);
        assert!(started.elapsed() <= Duration::from_millis(2500));
        responder.await.unwrap();
        drop(silent);
    }
}
