use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS,
    ERROR_INSUFFICIENT_BUFFER, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
    GetTokenInformation, TokenUser, ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION,
    CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERITED_ACE, OBJECT_INHERIT_ACE,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FileIdInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, MoveFileExW,
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_INFO,
    FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, OPEN_EXISTING,
    READ_CONTROL, SYNCHRONIZE, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetConsoleScreenBufferInfo, GetStdHandle, ReadConsoleInputW, SetConsoleMode,
    CONSOLE_SCREEN_BUFFER_INFO, ENABLE_ECHO_INPUT, ENABLE_EXTENDED_FLAGS, ENABLE_LINE_INPUT,
    ENABLE_PROCESSED_INPUT, ENABLE_PROCESSED_OUTPUT, ENABLE_QUICK_EDIT_MODE,
    ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, INPUT_RECORD, KEY_EVENT,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Memory::{VirtualLock, VirtualUnlock};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, WaitForSingleObject,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileIdentity {
    volume_serial: u64,
    file_id: [u8; 16],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileStamp {
    bytes: Vec<u8>,
}

impl FileStamp {
    pub fn version_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

pub struct RawModeGuard {
    // Store the HANDLE value rather than its raw pointer type so guards can
    // remain Send when held across an async prompt.
    handle: isize,
    saved: u32,
}

pub struct VtOutputGuard {
    handle: isize,
    saved: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProgramKind {
    Native,
    CmdShim,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedProgram {
    pub path: PathBuf,
    pub kind: ProgramKind,
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: the descriptor came from LocalAlloc through the SDDL
        // conversion API and remains owned by this guard.
        unsafe {
            LocalFree(self.0.cast());
        }
    }
}

struct SecurityInfo {
    // Owner and DACL point into this allocation. It therefore remains first-
    // class state rather than being freed immediately after GetSecurityInfo.
    _descriptor: SecurityDescriptor,
    owner: PSID,
    dacl: *mut ACL,
    directory: bool,
}

impl SecurityInfo {
    fn from_handle(handle: HANDLE, directory: bool) -> io::Result<Self> {
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: all outputs are valid pointers; the returned descriptor owns
        // the owner and DACL pointers and is freed by SecurityDescriptor.
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
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Self {
            _descriptor: SecurityDescriptor(descriptor),
            owner,
            dacl,
            directory,
        })
    }

    #[cfg(test)]
    fn from_descriptor(descriptor: SecurityDescriptor, directory: bool) -> io::Result<Self> {
        let mut owner: PSID = null_mut();
        let mut owner_defaulted = 0;
        // SAFETY: descriptor is live and both outputs are valid pointers.
        if unsafe {
            windows_sys::Win32::Security::GetSecurityDescriptorOwner(
                descriptor.0,
                &mut owner,
                &mut owner_defaulted,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut dacl_present = 0;
        let mut dacl: *mut ACL = null_mut();
        let mut dacl_defaulted = 0;
        // SAFETY: descriptor is live and all outputs are valid pointers.
        if unsafe {
            windows_sys::Win32::Security::GetSecurityDescriptorDacl(
                descriptor.0,
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if dacl_present == 0 {
            dacl = null_mut();
        }
        Ok(Self {
            _descriptor: descriptor,
            owner,
            dacl,
            directory,
        })
    }
}

struct CurrentSid {
    // TOKEN_USER contains an internal pointer into this allocation. A Vec of
    // usize supplies the alignment TOKEN_USER requires and is never resized.
    storage: Vec<usize>,
}

impl CurrentSid {
    fn get() -> io::Result<Self> {
        let mut token: HANDLE = null_mut();
        // SAFETY: token is a valid out pointer and the pseudo-process handle is
        // valid for the duration of the call.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut required = 0_u32;
        // SAFETY: the null-buffer query is the documented size probe.
        let first = unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required) };
        if first != 0
            || required == 0
            || io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32)
        {
            // SAFETY: token is the owned handle returned above and has not yet
            // been closed.
            unsafe {
                CloseHandle(token);
            }
            return Err(io::Error::last_os_error());
        }
        let words = (required as usize).div_ceil(size_of::<usize>());
        let mut storage = vec![0_usize; words];
        // SAFETY: storage is aligned, writable, and at least `required` bytes.
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                storage.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        };
        // SAFETY: token is the owned handle returned above and is closed
        // exactly once after the final token query.
        unsafe {
            CloseHandle(token);
        }
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { storage })
    }

    fn as_ptr(&self) -> PSID {
        // SAFETY: GetTokenInformation initialized the allocation as TOKEN_USER;
        // the SID pointer remains valid while `storage` remains allocated.
        unsafe { (*(self.storage.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    }

    fn as_sddl(&self) -> io::Result<String> {
        let mut string_sid = null_mut();
        // SAFETY: the SID was returned for the current token and string_sid is
        // a valid out pointer freed with LocalFree below.
        if unsafe { ConvertSidToStringSidW(self.as_ptr(), &mut string_sid) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0;
        // SAFETY: ConvertSidToStringSidW returns a NUL-terminated allocation.
        unsafe {
            while *string_sid.add(len) != 0 {
                len += 1;
            }
        }
        // SAFETY: the scan above established the initialized string length.
        let value = String::from_utf16(unsafe { std::slice::from_raw_parts(string_sid, len) })
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "current SID is not UTF-16"));
        // SAFETY: ConvertSidToStringSidW allocated this exact pointer.
        unsafe {
            LocalFree(string_sid.cast());
        }
        value
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn descriptor_from_sddl(sddl: &str) -> io::Result<SecurityDescriptor> {
    let sddl = wide(OsStr::new(sddl));
    let mut descriptor = null_mut();
    // SAFETY: the UTF-16 input is NUL-terminated and descriptor is a valid out
    // pointer. The returned LocalAlloc block is owned by the guard.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(SecurityDescriptor(descriptor))
}

fn private_descriptor(directory: bool) -> io::Result<SecurityDescriptor> {
    let sid = CurrentSid::get()?.as_sddl()?;
    let inheritance = if directory { "OICI" } else { "" };
    descriptor_from_sddl(&format!("O:{sid}D:P(A;{inheritance};FA;;;{sid})"))
}

fn with_security_attributes<T>(
    directory: bool,
    call: impl FnOnce(*const SECURITY_ATTRIBUTES) -> T,
) -> io::Result<T> {
    let descriptor = private_descriptor(directory)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    Ok(call(&attributes))
}

fn open_handle(path: &Path, directory: bool, write: bool) -> io::Result<File> {
    let path = wide(path.as_os_str());
    let mut access = FILE_GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES;
    if write {
        access |= FILE_GENERIC_WRITE;
    }
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
    let share = FILE_SHARE_READ
        | FILE_SHARE_WRITE
        | if directory {
            // Directory capabilities deliberately pin their containing path.
            0
        } else {
            // Verified file handles may outlive the path operation that
            // follows. Windows requires every extant handle to share delete
            // access for either an atomic rename or an unlink to succeed.
            FILE_SHARE_DELETE
        };
    // SAFETY: path is NUL-terminated, optional pointers are null, and the
    // returned owned handle is immediately transferred to File.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            share,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a new owned kernel handle.
    let file = unsafe { File::from_raw_handle(handle.cast()) };
    validate_handle(&file, Some(directory))?;
    Ok(file)
}

fn create_file_new(path: &Path) -> io::Result<File> {
    let path = wide(path.as_os_str());
    let handle = with_security_attributes(false, |attributes| {
        // SAFETY: path and attributes stay alive for this call; the returned
        // handle, when valid, is uniquely owned by the caller.
        unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | READ_CONTROL,
                // Match Rust's ordinary OpenOptions sharing contract: secret
                // publication and scrollback eviction must remain possible
                // while this validated handle is live.
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                attributes,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        }
    })?;
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned a new owned kernel handle.
    let file = unsafe { File::from_raw_handle(handle.cast()) };
    validate_handle(&file, Some(false))?;
    Ok(file)
}

fn validate_handle(file: &File, directory: Option<bool>) -> io::Result<()> {
    let handle = file.as_raw_handle().cast();
    // SAFETY: a zeroed BY_HANDLE_FILE_INFORMATION is valid output storage for
    // GetFileInformationByHandle.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    // SAFETY: file owns a live handle and info is a correctly sized out value.
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path is a reparse point",
        ));
    }
    let is_directory = info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if let Some(expected_directory) = directory {
        if is_directory != expected_directory {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                if expected_directory {
                    "private path is not a directory"
                } else {
                    "private path is not a regular file"
                },
            ));
        }
    }
    validate_handle_acl(handle, is_directory)
}

fn validate_handle_acl(handle: HANDLE, directory: bool) -> io::Result<()> {
    let current = CurrentSid::get()?;
    let info = SecurityInfo::from_handle(handle, directory)?;
    validate_security(&info, current.as_ptr())
}

fn validate_security(info: &SecurityInfo, expected_sid: PSID) -> io::Result<()> {
    // SAFETY: owner belongs to the live security descriptor and expected_sid
    // remains valid for the duration of this validation.
    if info.owner.is_null() || unsafe { EqualSid(info.owner, expected_sid) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path owner is not the current user",
        ));
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: info retains the descriptor and the out pointers are valid.
    if unsafe { GetSecurityDescriptorControl(info._descriptor.0, &mut control, &mut revision) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path DACL inheritance is enabled",
        ));
    }
    if info.dacl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path has no DACL",
        ));
    }
    // SAFETY: a zeroed ACL_SIZE_INFORMATION is valid output storage.
    let mut acl_info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
    // SAFETY: dacl belongs to the live descriptor and acl_info is correctly
    // sized for the requested information class.
    if unsafe {
        GetAclInformation(
            info.dacl,
            (&mut acl_info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if acl_info.AceCount != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path DACL is not owner-only",
        ));
    }
    let mut raw_ace: *mut c_void = null_mut();
    // SAFETY: the ACL reports one ACE and raw_ace is a valid out pointer.
    if unsafe { GetAce(info.dacl, 0, &mut raw_ace) } == 0 || raw_ace.is_null() {
        return Err(io::Error::last_os_error());
    }
    // ACCESS_ALLOWED_ACE_TYPE is zero. Avoid adding the broad SystemServices
    // feature solely for this stable Win32 ABI constant.
    // SAFETY: GetAce returned a non-null pointer to the sole ACE in the live
    // ACL; ACCESS_ALLOWED_ACE is the layout required by AceType zero.
    let ace = unsafe { &*(raw_ace.cast::<ACCESS_ALLOWED_ACE>()) };
    let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast();
    let expected_flags = if info.directory {
        (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
    } else {
        0
    };
    // SAFETY: ace_sid points inside the live ACCESS_ALLOWED_ACE and
    // expected_sid is the current-token SID held by validate_handle_acl.
    let ace_matches_current = unsafe { EqualSid(ace_sid, expected_sid) } != 0;
    if ace.Header.AceType != 0
        || ace.Header.AceFlags != expected_flags
        || ace.Header.AceFlags & INHERITED_ACE as u8 != 0
        || ace.Mask != FILE_ALL_ACCESS
        || !ace_matches_current
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private path DACL grants access beyond the current user",
        ));
    }
    Ok(())
}

fn leaf_under(parent: &Dir, name: &Path) -> io::Result<PathBuf> {
    let mut components = name.components();
    let Component::Normal(leaf) = components.next().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "private path has no leaf name")
    })?
    else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private path must be a relative leaf name",
        ));
    };
    if components.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private path must be a single leaf name",
        ));
    }
    Ok(final_path(parent)?.join(leaf))
}

fn final_path(dir: &Dir) -> io::Result<PathBuf> {
    let handle = dir.as_raw_handle().cast();
    // SAFETY: a null output with zero length is the documented size query.
    let needed = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u16; needed as usize + 1];
    // SAFETY: buffer has the capacity passed to the API and the handle remains
    // live for the entire call.
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(written as usize);
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

pub fn default_config_base() -> io::Result<PathBuf> {
    dirs::config_local_dir()
        .map(|path| path.join("spawn"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot resolve local config dir"))
}

pub fn create_private_dir_all(path: &Path) -> io::Result<()> {
    if path.try_exists()? {
        return validate_private_dir(path);
    }
    let mut missing = Vec::new();
    let mut cursor = path;
    while !cursor.try_exists()? {
        missing.push(cursor.to_path_buf());
        cursor = cursor.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "private directory has no existing parent",
            )
        })?;
    }
    for component in missing.iter().rev() {
        let path_wide = wide(component.as_os_str());
        let created = with_security_attributes(true, |attributes| unsafe {
            // SAFETY: path and attributes remain alive for this call.
            CreateDirectoryW(path_wide.as_ptr(), attributes)
        })?;
        if created == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
                return Err(error);
            }
        }
        validate_private_dir(component)?;
    }
    validate_private_dir(path)
}

pub fn validate_private_dir(path: &Path) -> io::Result<()> {
    drop(open_handle(path, true, false)?);
    Ok(())
}

pub fn open_private_dir(path: &Path) -> io::Result<Dir> {
    Ok(Dir::from_std_file(open_handle(path, true, true)?))
}

pub fn open_or_create_private_dir_at(parent: &Dir, name: &Path) -> io::Result<Dir> {
    let path = leaf_under(parent, name)?;
    create_private_dir_all(&path)?;
    open_private_dir(&path)
}

pub fn create_private_file_new(path: &Path) -> io::Result<File> {
    create_file_new(path)
}

pub fn open_private_file(path: &Path, write: bool) -> io::Result<File> {
    open_handle(path, false, write)
}

pub fn create_private_file_new_at(parent: &Dir, name: &Path) -> io::Result<File> {
    create_file_new(&leaf_under(parent, name)?)
}

pub fn open_private_file_at(parent: &Dir, name: &Path, write: bool) -> io::Result<File> {
    open_handle(&leaf_under(parent, name)?, false, write)
}

pub fn validate_private_file(file: &File) -> io::Result<()> {
    validate_handle(file, Some(false))
}

pub fn owned_by_current_user(file: &File) -> io::Result<bool> {
    let current = CurrentSid::get()?;
    let mut owner: PSID = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: outputs are valid and descriptor is freed below.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle().cast(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _descriptor = SecurityDescriptor(descriptor);
    // SAFETY: owner belongs to the live descriptor and current owns a valid
    // current-token SID.
    Ok(!owner.is_null() && unsafe { EqualSid(owner, current.as_ptr()) } != 0)
}

pub fn set_executable(_path: &Path) -> io::Result<()> {
    // PE executability is encoded in the image and filename; Windows has no
    // chmod executable bit.
    Ok(())
}

fn move_file(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    let from = wide(from.as_os_str());
    let to = wide(to.as_os_str());
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    // SAFETY: both strings are NUL-terminated and remain alive for the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(code)
                if code == ERROR_ALREADY_EXISTS as i32 || code == ERROR_FILE_EXISTS as i32 =>
            {
                Err(io::Error::new(io::ErrorKind::AlreadyExists, error))
            }
            _ => Err(error),
        };
    }
    Ok(())
}

pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    move_file(from, to, false)
}

pub fn durable_replace(from: &Path, to: &Path) -> io::Result<()> {
    move_file(from, to, true)
}

/// No-op: Windows has no directory fsync, and `move_file` already passes
/// `MOVEFILE_WRITE_THROUGH`, so the rename is committed before it returns.
/// Present so callers can stay platform-agnostic.
pub fn sync_parent_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn rename_noreplace_at(parent: &Dir, from: &Path, to: &Path) -> io::Result<()> {
    move_file_at_verified(parent, from, to, false)
}

pub fn durable_replace_at(parent: &Dir, from: &Path, to: &Path) -> io::Result<()> {
    move_file_at_verified(parent, from, to, true)
}

fn move_file_at_verified(parent: &Dir, from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let source = parent.open_with(from, &options)?.into_std();
    let expected = file_identity(&source)?;
    // cap-std opens ordinary files with FILE_SHARE_DELETE, while the parent
    // directory capability deliberately omits it. Holding both pins the file
    // identity and the containing directory throughout the path-based move.
    move_file(
        &leaf_under(parent, from)?,
        &leaf_under(parent, to)?,
        replace,
    )?;
    let destination = parent.open_with(to, &options)?.into_std();
    if file_identity(&destination)? != expected {
        return Err(io::Error::other(
            "published file identity changed during Windows rename",
        ));
    }
    Ok(())
}

pub fn hard_link_noreplace_at(
    from_dir: &Dir,
    from: &Path,
    to_dir: &Dir,
    to: &Path,
) -> io::Result<()> {
    from_dir.hard_link(from, to_dir, to)
}

pub fn fsync_dir(_dir: &Dir) -> io::Result<()> {
    // Windows documents no FlushFileBuffers durability contract for directory
    // handles. Callers flush the file before write-through publication.
    Ok(())
}

fn file_information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: a zeroed BY_HANDLE_FILE_INFORMATION is valid output storage.
    let mut info = unsafe { zeroed() };
    // SAFETY: file owns a live handle and info is a valid out value.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

pub fn file_identity(file: &File) -> io::Result<FileIdentity> {
    // SAFETY: a zeroed FILE_ID_INFO is valid output storage for FileIdInfo.
    let mut info: FILE_ID_INFO = unsafe { zeroed() };
    // SAFETY: info has the exact size required for FileIdInfo.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle().cast(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } != 0
    {
        return Ok(FileIdentity {
            volume_serial: info.VolumeSerialNumber,
            file_id: info.FileId.Identifier,
        });
    }
    let legacy = file_information(file)?;
    let mut file_id = [0_u8; 16];
    file_id[..4].copy_from_slice(&legacy.nFileIndexHigh.to_le_bytes());
    file_id[4..8].copy_from_slice(&legacy.nFileIndexLow.to_le_bytes());
    Ok(FileIdentity {
        volume_serial: legacy.dwVolumeSerialNumber as u64,
        file_id,
    })
}

fn filetime_u64(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

pub fn file_stamp(file: &File) -> io::Result<FileStamp> {
    let identity = file_identity(file)?;
    let info = file_information(file)?;
    let len = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
    let mut bytes = Vec::with_capacity(40);
    bytes.extend_from_slice(&identity.volume_serial.to_le_bytes());
    bytes.extend_from_slice(&identity.file_id);
    bytes.extend_from_slice(&len.to_le_bytes());
    bytes.extend_from_slice(&filetime_u64(info.ftLastWriteTime).to_le_bytes());
    Ok(FileStamp { bytes })
}

pub fn lock_secret(region: &[u8]) -> bool {
    region.is_empty()
        || unsafe {
            // SAFETY: the slice remains allocated for the call and VirtualLock
            // does not retain a Rust reference.
            VirtualLock(region.as_ptr().cast(), region.len()) != 0
        }
}

pub fn unlock_secret(region: &[u8]) {
    if !region.is_empty() {
        unsafe {
            // SAFETY: this is the same still-live slice passed to VirtualLock.
            let _ = VirtualUnlock(region.as_ptr().cast(), region.len());
        }
    }
}

pub fn enable_raw_mode() -> Option<RawModeGuard> {
    // SAFETY: GetStdHandle returns a borrowed console handle.
    let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut saved = 0_u32;
    // SAFETY: saved is a valid out value and handle is borrowed, not closed.
    if unsafe { GetConsoleMode(handle, &mut saved) } == 0 {
        return None;
    }
    let raw = raw_console_mode(saved);
    // SAFETY: handle is a console input handle and saved is restored on Drop.
    if unsafe { SetConsoleMode(handle, raw) } == 0 {
        let _ = unsafe { SetConsoleMode(handle, saved) };
        return None;
    }
    Some(RawModeGuard {
        handle: handle as isize,
        saved,
    })
}

/// Consume console key records until Enter, checking `done` every 100 ms.
///
/// This uses the console event API instead of `stdin().read_line`, because a
/// line read cannot be cancelled after another device approves the login and
/// would retain stdin across any prompt that follows the ceremony.
pub fn wait_for_enter_until(done: &AtomicBool) -> bool {
    // SAFETY: GetStdHandle returns a process-owned borrowed console handle.
    let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return false;
    }
    while !done.load(Ordering::Acquire) {
        // SAFETY: handle remains process-owned and valid for this wait.
        match unsafe { WaitForSingleObject(handle, 100) } {
            WAIT_TIMEOUT => continue,
            WAIT_OBJECT_0 => {}
            _ => return false,
        }
        if done.load(Ordering::Acquire) {
            return false;
        }
        let mut record = INPUT_RECORD::default();
        let mut read = 0_u32;
        // SAFETY: record and read are valid out-pointers for a single event;
        // the borrowed console handle is not closed by this call.
        if unsafe { ReadConsoleInputW(handle, &mut record, 1, &mut read) } == 0 || read == 0 {
            return false;
        }
        if record.EventType as u32 == KEY_EVENT {
            // SAFETY: EventType identifies the active union member.
            let key = unsafe { record.Event.KeyEvent };
            if key.bKeyDown != 0 {
                // SAFETY: UnicodeChar is the active representation for the W API.
                let character = unsafe { key.uChar.UnicodeChar };
                if character == b'\r' as u16 || character == b'\n' as u16 {
                    return true;
                }
            }
        }
    }
    false
}

fn raw_console_mode(saved: u32) -> u32 {
    (saved
        & !(ENABLE_LINE_INPUT
            | ENABLE_ECHO_INPUT
            | ENABLE_PROCESSED_INPUT
            | ENABLE_QUICK_EDIT_MODE))
        | ENABLE_EXTENDED_FLAGS
        | ENABLE_VIRTUAL_TERMINAL_INPUT
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        // SAFETY: the console handle is process-owned and the saved mode came
        // from that exact handle.
        unsafe {
            let _ = SetConsoleMode(self.handle as HANDLE, self.saved);
        }
    }
}

/// Console echo, suppressed for the guard's lifetime and restored on drop.
pub struct EchoGuard {
    handle: usize,
    saved: u32,
}

/// Stop the console echoing what is typed, for the same reason as the Unix
/// implementation: a live region repaints rows in place, and echoed input
/// lands inside the frame and displaces every rewind after it.
pub fn suppress_echo() -> Option<EchoGuard> {
    // SAFETY: GetStdHandle returns a borrowed console handle.
    let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut saved = 0_u32;
    // SAFETY: saved is a valid out value and handle is borrowed, not closed.
    if unsafe { GetConsoleMode(handle, &mut saved) } == 0 {
        return None;
    }
    // ENABLE_LINE_INPUT stays on so a waiting reader still wakes on a whole
    // line; only the echoing of it goes away.
    // SAFETY: handle is a console input handle and saved is restored on Drop.
    if unsafe { SetConsoleMode(handle, saved & !ENABLE_ECHO_INPUT) } == 0 {
        return None;
    }
    Some(EchoGuard {
        handle: handle as usize,
        saved,
    })
}

impl Drop for EchoGuard {
    fn drop(&mut self) {
        // SAFETY: the handle is the borrowed console input handle this guard
        // read its saved mode from; it is not closed here.
        unsafe {
            let _ = SetConsoleMode(self.handle as HANDLE, self.saved);
        }
    }
}

pub fn enable_vt_output() -> Option<VtOutputGuard> {
    // SAFETY: GetStdHandle returns a borrowed console handle.
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut saved = 0_u32;
    // SAFETY: saved is a valid out value and handle is borrowed, not closed.
    if unsafe { GetConsoleMode(handle, &mut saved) } == 0 {
        return None;
    }
    let vt = vt_output_mode(saved);
    // SAFETY: handle is a console output handle and saved is restored on Drop.
    if unsafe { SetConsoleMode(handle, vt) } == 0 {
        // SAFETY: handle is the same borrowed console output handle and saved
        // came from its successful GetConsoleMode call.
        let _ = unsafe { SetConsoleMode(handle, saved) };
        return None;
    }
    Some(VtOutputGuard {
        handle: handle as isize,
        saved,
    })
}

fn vt_output_mode(saved: u32) -> u32 {
    saved | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
}

impl Drop for VtOutputGuard {
    fn drop(&mut self) {
        // SAFETY: the console handle is process-owned and the saved mode came
        // from that exact handle.
        unsafe {
            let _ = SetConsoleMode(self.handle as HANDLE, self.saved);
        }
    }
}

pub fn terminal_size() -> Option<(u16, u16)> {
    // SAFETY: GetStdHandle returns a borrowed console handle.
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: a zeroed CONSOLE_SCREEN_BUFFER_INFO is valid output storage.
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { zeroed() };
    // SAFETY: handle is a borrowed live console output handle and info is a
    // correctly sized out value.
    if unsafe { GetConsoleScreenBufferInfo(handle, &mut info) } == 0 {
        return None;
    }
    let width = info.srWindow.Right - info.srWindow.Left + 1;
    let height = info.srWindow.Bottom - info.srWindow.Top + 1;
    (width > 0 && height > 0).then_some((width as u16, height as u16))
}

pub fn open_url(url: &str) -> io::Result<()> {
    let url = url.to_owned();
    std::thread::Builder::new()
        .name("spawnd-browser-opener".into())
        .spawn(move || {
            // SAFETY: this thread has not initialized COM; the matching
            // CoUninitialize is held by ComGuard on every successful path.
            let initialize = unsafe {
                CoInitializeEx(
                    null(),
                    (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
                )
            };
            if initialize < 0 {
                return Err(io::Error::other(format!(
                    "initializing browser launch apartment failed (HRESULT {initialize:#x})"
                )));
            }
            struct ComGuard;
            impl Drop for ComGuard {
                fn drop(&mut self) {
                    // SAFETY: this guard exists only after successful COM
                    // initialization on this same thread.
                    unsafe { CoUninitialize() };
                }
            }
            let _com = ComGuard;
            let operation = wide(OsStr::new("open"));
            let url = wide(OsStr::new(&url));
            // SAFETY: every string pointer is NUL-terminated and live for the
            // synchronous call; null HWND/directory/parameters are permitted.
            let result = unsafe {
                ShellExecuteW(
                    null_mut(),
                    operation.as_ptr(),
                    url.as_ptr(),
                    null(),
                    null(),
                    SW_SHOWNORMAL,
                )
            } as isize;
            if shell_execute_succeeded(result) {
                Ok(())
            } else {
                Err(io::Error::other(format!(
                    "Windows browser opener failed with ShellExecute code {result}"
                )))
            }
        })?
        .join()
        .map_err(|_| io::Error::other("browser opener thread panicked"))?
}

fn shell_execute_succeeded(result: isize) -> bool {
    result > 32
}

pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: no handle inheritance is requested and pid is an input value.
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return io::Error::last_os_error().raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
    }
    // SAFETY: handle is live and closed immediately after the nonblocking poll.
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    // SAFETY: handle is the owned OpenProcess handle and is closed exactly
    // once after the poll.
    unsafe {
        CloseHandle(handle);
    }
    match wait {
        WAIT_TIMEOUT => true,
        WAIT_OBJECT_0 => false,
        _ => true,
    }
}

fn env_os_case_insensitive(name: &str) -> Option<OsString> {
    std::env::vars_os().find_map(|(key, value)| {
        key.to_string_lossy()
            .eq_ignore_ascii_case(name)
            .then_some(value)
    })
}

pub fn resolve_program(path: &Path) -> Option<ResolvedProgram> {
    fn classify(candidate: PathBuf) -> Option<ResolvedProgram> {
        let path = std::fs::canonicalize(candidate).ok()?;
        if !path.is_file() {
            return None;
        }
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase());
        let kind = match extension.as_deref() {
            Some("cmd" | "bat") => ProgramKind::CmdShim,
            _ => ProgramKind::Native,
        };
        Some(ResolvedProgram { path, kind })
    }

    fn candidates(base: &Path) -> Vec<PathBuf> {
        if base.extension().is_some() {
            return vec![base.to_path_buf()];
        }
        let path_ext = env_os_case_insensitive("PATHEXT")
            .unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
        path_ext
            .to_string_lossy()
            .split(';')
            .filter_map(|extension| {
                let extension = extension.trim();
                if extension.is_empty() {
                    return None;
                }
                let mut name = base.as_os_str().to_os_string();
                if extension.starts_with('.') {
                    name.push(extension);
                } else {
                    name.push(".");
                    name.push(extension);
                }
                Some(PathBuf::from(name))
            })
            .collect()
    }

    let has_directory = path.is_absolute() || path.components().count() > 1;
    if has_directory {
        return candidates(path).into_iter().find_map(classify);
    }
    let search = env_os_case_insensitive("PATH")?;
    std::env::split_paths(&search).find_map(|directory| {
        candidates(&directory.join(path))
            .into_iter()
            .find_map(classify)
    })
}

pub fn executable_name(stem: &str) -> OsString {
    let mut name = OsString::from(stem);
    name.push(std::env::consts::EXE_SUFFIX);
    name
}

pub fn executable_variant(live: &Path, tag: &str) -> io::Result<PathBuf> {
    if tag.is_empty() || tag.contains('/') || tag.contains('\\') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid executable variant tag",
        ));
    }
    let name = live.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "executable path has no file name",
        )
    })?;
    let mut units: Vec<u16> = name.encode_wide().collect();
    let suffix: Vec<u16> = OsStr::new(std::env::consts::EXE_SUFFIX)
        .encode_wide()
        .collect();
    if units.len() < suffix.len()
        || !units[units.len() - suffix.len()..]
            .iter()
            .zip(&suffix)
            .all(|(left, right)| ascii_lower_u16(*left) == ascii_lower_u16(*right))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows executable path does not end in .exe",
        ));
    }
    units.truncate(units.len() - suffix.len());
    units.push('.' as u16);
    units.extend(OsStr::new(tag).encode_wide());
    units.extend(suffix);
    Ok(live.with_file_name(OsString::from_wide(&units)))
}

fn ascii_lower_u16(value: u16) -> u16 {
    if (b'A' as u16..=b'Z' as u16).contains(&value) {
        value + (b'a' - b'A') as u16
    } else {
        value
    }
}

#[cfg(test)]
pub fn symlink_fixture_unavailable(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || error.raw_os_error()
            == Some(windows_sys::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn security_info_from_sddl(sddl: &str, directory: bool) -> SecurityInfo {
        SecurityInfo::from_descriptor(descriptor_from_sddl(sddl).unwrap(), directory).unwrap()
    }

    fn replace_file_dacl(path: &Path, sddl: &str) {
        use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
        use windows_sys::Win32::Security::PROTECTED_DACL_SECURITY_INFORMATION;

        let info = security_info_from_sddl(sddl, false);
        let path = wide(path.as_os_str());
        // SAFETY: the path is NUL-terminated, the DACL belongs to `info` for
        // the duration of the call, and the remaining optional SID/ACL inputs
        // are deliberately null because this test replaces only the DACL.
        let status = unsafe {
            SetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                info.dacl,
                null_mut(),
            )
        };
        assert_eq!(status, 0, "SetNamedSecurityInfoW failed with {status}");
    }

    #[test]
    fn security_validation_rejects_the_wrong_expected_sid() {
        let current_sid = CurrentSid::get().unwrap();
        let current = current_sid.as_sddl().unwrap();
        let valid = security_info_from_sddl(&format!("O:{current}D:P(A;;FA;;;{current})"), false);
        let system = security_info_from_sddl("O:SYD:P(A;;FA;;;SY)", false);

        assert_eq!(
            validate_security(&valid, system.owner).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn security_validation_rejects_a_system_only_ace() {
        let current_sid = CurrentSid::get().unwrap();
        let current = current_sid.as_sddl().unwrap();
        let system_only = security_info_from_sddl(&format!("O:{current}D:P(A;;FA;;;SY)"), false);

        assert_eq!(
            validate_security(&system_only, current_sid.as_ptr())
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn real_file_validation_rejects_a_second_everyone_ace() {
        let temp = tempfile::tempdir().unwrap();
        let private = temp.path().join("private");
        create_private_dir_all(&private).unwrap();
        let path = private.join("secret");
        let file = create_private_file_new(&path).unwrap();
        let current = CurrentSid::get().unwrap().as_sddl().unwrap();

        replace_file_dacl(
            &path,
            &format!("O:{current}D:P(A;;FA;;;{current})(A;;FA;;;WD)"),
        );
        assert_eq!(
            validate_private_file(&file).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );

        // Restore the owner-only DACL so temporary-directory cleanup remains
        // deterministic even on runners with unusually restrictive policies.
        replace_file_dacl(&path, &format!("O:{current}D:P(A;;FA;;;{current})"));
        validate_private_file(&file).unwrap();
    }

    #[test]
    fn private_objects_have_a_canonical_owner_dacl() {
        let temp = tempfile::tempdir().unwrap();
        let private = temp.path().join("private");
        create_private_dir_all(&private).unwrap();
        validate_private_dir(&private).unwrap();
        let file = create_private_file_new(&private.join("secret")).unwrap();
        validate_private_file(&file).unwrap();
        assert!(owned_by_current_user(&file).unwrap());
    }

    #[test]
    fn default_config_uses_local_not_roaming_or_unix_state_fallbacks() {
        let local = dirs::config_local_dir().expect("Windows LocalAppData");
        let base = default_config_base().unwrap();
        assert_eq!(base, local.join("spawn"));
        if let Some(roaming) = dirs::config_dir().filter(|roaming| roaming != &local) {
            assert_ne!(base, roaming.join("spawn"));
        }
        if let Some(home) = dirs::home_dir() {
            assert_ne!(base, home.join(".local/state/spawn"));
        }
    }

    #[test]
    fn validation_rejects_and_never_repairs_inherited_security() {
        let temp = tempfile::tempdir().unwrap();
        let ordinary_dir = temp.path().join("ordinary");
        std::fs::create_dir(&ordinary_dir).unwrap();
        let first = validate_private_dir(&ordinary_dir).unwrap_err();
        let second = validate_private_dir(&ordinary_dir).unwrap_err();
        assert_eq!(first.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(second.kind(), io::ErrorKind::PermissionDenied);

        let ordinary_file = temp.path().join("ordinary-file");
        std::fs::write(&ordinary_file, b"not private").unwrap();
        assert_eq!(
            open_private_file(&ordinary_file, false).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn private_open_refuses_file_and_directory_reparse_points() {
        let temp = tempfile::tempdir().unwrap();
        let private = temp.path().join("private");
        create_private_dir_all(&private).unwrap();
        let target_file = private.join("target-file");
        create_private_file_new(&target_file).unwrap();
        let file_link = private.join("file-link");
        match std::os::windows::fs::symlink_file(&target_file, &file_link) {
            Ok(()) => assert_eq!(
                open_private_file(&file_link, false).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            ),
            Err(error) if symlink_fixture_unavailable(&error) => {}
            Err(error) => panic!("creating file symlink failed unexpectedly: {error}"),
        }

        let target_dir = private.join("target-dir");
        create_private_dir_all(&target_dir).unwrap();
        let dir_link = private.join("dir-link");
        match std::os::windows::fs::symlink_dir(&target_dir, &dir_link) {
            Ok(()) => assert_eq!(
                open_private_dir(&dir_link).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            ),
            Err(error) if symlink_fixture_unavailable(&error) => {}
            Err(error) => panic!("creating directory symlink failed unexpectedly: {error}"),
        }
    }

    #[test]
    fn private_open_refuses_a_junction_without_requiring_developer_mode() {
        let temp = tempfile::tempdir().unwrap();
        let private = temp.path().join("private");
        let target = temp.path().join("target");
        create_private_dir_all(&private).unwrap();
        create_private_dir_all(&target).unwrap();
        let junction = private.join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .expect("cmd.exe must be available on Windows CI");
        assert!(status.success(), "mklink /J failed with {status}");
        assert_eq!(
            open_private_dir(&junction).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn console_mode_masks_and_shell_execute_boundaries_are_exact() {
        let saved_input = ENABLE_LINE_INPUT
            | ENABLE_ECHO_INPUT
            | ENABLE_PROCESSED_INPUT
            | ENABLE_QUICK_EDIT_MODE
            | 0x0008;
        let raw = raw_console_mode(saved_input);
        assert_eq!(
            raw & (ENABLE_LINE_INPUT
                | ENABLE_ECHO_INPUT
                | ENABLE_PROCESSED_INPUT
                | ENABLE_QUICK_EDIT_MODE),
            0
        );
        assert_ne!(raw & ENABLE_EXTENDED_FLAGS, 0);
        assert_ne!(raw & ENABLE_VIRTUAL_TERMINAL_INPUT, 0);
        assert_ne!(raw & 0x0008, 0);

        let saved_output = 0x0001;
        let vt = vt_output_mode(saved_output);
        assert_ne!(vt & ENABLE_PROCESSED_OUTPUT, 0);
        assert_ne!(vt & ENABLE_VIRTUAL_TERMINAL_PROCESSING, 0);
        assert_ne!(vt & saved_output, 0);

        assert!(!shell_execute_succeeded(0));
        assert!(!shell_execute_succeeded(32));
        assert!(shell_execute_succeeded(33));

        let url = "https://example.test/approve?a=1&b=two#fragment";
        let encoded = wide(OsStr::new(url));
        assert_eq!(encoded.last(), Some(&0));
        assert_eq!(
            OsString::from_wide(&encoded[..encoded.len() - 1]),
            OsString::from(url)
        );
    }

    #[test]
    fn no_replace_preserves_both_files() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("from");
        let to = temp.path().join("to");
        std::fs::write(&from, b"from").unwrap();
        std::fs::write(&to, b"to").unwrap();
        assert_eq!(
            rename_noreplace(&from, &to).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(from).unwrap(), b"from");
        assert_eq!(std::fs::read(to).unwrap(), b"to");
    }

    #[test]
    fn hard_link_no_replace_preserves_destination_and_identity_is_stable() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("private");
        create_private_dir_all(&parent).unwrap();
        let source = parent.join("source");
        let destination = parent.join("destination");
        let source_file = create_private_file_new(&source).unwrap();
        let destination_file = create_private_file_new(&destination).unwrap();
        let parent_dir = open_private_dir(&parent).unwrap();
        assert_eq!(
            hard_link_noreplace_at(
                &parent_dir,
                Path::new("source"),
                &parent_dir,
                Path::new("destination"),
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_ne!(
            file_identity(&source_file).unwrap(),
            file_identity(&destination_file).unwrap()
        );
        drop(destination_file);
        std::fs::remove_file(&destination).unwrap();
        hard_link_noreplace_at(
            &parent_dir,
            Path::new("source"),
            &parent_dir,
            Path::new("destination"),
        )
        .unwrap();
        let linked = open_private_file(&destination, false).unwrap();
        assert_eq!(
            file_identity(&source_file).unwrap(),
            file_identity(&linked).unwrap()
        );
    }
}
