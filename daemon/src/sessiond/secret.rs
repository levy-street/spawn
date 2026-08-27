//! Memory hygiene for key material and plaintext buffers.
//!
//! What this module guarantees (docs/SESSIOND.md "Memory hygiene"):
//! - key bytes are zeroized on drop,
//! - key pages are `mlock(2)`ed (never swapped) where the RLIMIT permits,
//!   or `VirtualLock`ed on Windows within the process working-set limit,
//! - on Linux, key pages are marked `MADV_DONTDUMP` so they stay out of
//!   core dumps.
//!
//! What it cannot guarantee: plaintext PTY bytes *must* transit worker
//! memory (kernel PTY buffer → userspace read buffer) before encryption, and
//! copies made inside the socket/TLS/PTY layers are outside our control. The
//! honest claim is *minimal plaintext residency on the user's own host*, not
//! "encrypted before DRAM".

use zeroize::Zeroize;

/// Fixed-size secret held in heap memory, page-locked on a best-effort basis,
/// excluded from dumps where the platform supports it, and zeroized on drop.
pub struct SecretBytes {
    buf: Box<[u8]>,
    locked: bool,
}

impl SecretBytes {
    /// Allocate `len` bytes of cryptographically random secret material.
    pub fn random(len: usize) -> anyhow::Result<Self> {
        let mut buf = vec![0u8; len].into_boxed_slice();
        getrandom::getrandom(&mut buf).map_err(|e| anyhow::anyhow!("getrandom failed: {e}"))?;
        let mut secret = Self { buf, locked: false };
        secret.locked = lock_region(&secret.buf);
        Ok(secret)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    /// Whether the platform page-lock call succeeded. Callers may log (not
    /// fail) when false: the scrollback log is still encrypted; only the
    /// swap-residency guarantee for the key weakens.
    pub fn is_locked(&self) -> bool {
        self.locked
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.buf.zeroize();
        if self.locked {
            unlock_region(&self.buf);
        }
    }
}

/// mlock + MADV_DONTDUMP the pages backing `region`. Returns true if the
/// mlock succeeded. Best-effort: failure (e.g. RLIMIT_MEMLOCK=0 containers)
/// must not break the worker.
fn lock_region(region: &[u8]) -> bool {
    if region.is_empty() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::ptr::NonNull;
        let ptr = match NonNull::new(region.as_ptr() as *mut std::ffi::c_void) {
            Some(p) => p,
            None => return false,
        };
        // SAFETY: ptr/len describe a live allocation owned by the caller for
        // the lifetime of the lock (we munlock in Drop before dealloc).
        let locked = unsafe { nix::sys::mman::mlock(ptr, region.len()) }.is_ok();
        #[cfg(target_os = "linux")]
        {
            // Keep the pages out of core dumps regardless of mlock outcome.
            // SAFETY: same live region as above; MADV_DONTDUMP does not
            // change the mapping's validity.
            let _ = unsafe {
                nix::sys::mman::madvise(
                    ptr,
                    region.len(),
                    nix::sys::mman::MmapAdvise::MADV_DONTDUMP,
                )
            };
        }
        locked
    }
    #[cfg(windows)]
    {
        // SAFETY: region describes a live allocation owned by the caller for
        // the lifetime of the lock; Drop unlocks the same address and length.
        unsafe {
            windows_sys::Win32::System::Memory::VirtualLock(region.as_ptr().cast(), region.len())
                != 0
        }
    }
}

fn unlock_region(region: &[u8]) {
    #[cfg(unix)]
    {
        use std::ptr::NonNull;
        if let Some(ptr) = NonNull::new(region.as_ptr() as *mut std::ffi::c_void) {
            // SAFETY: region was locked by lock_region on the same allocation.
            let _ = unsafe { nix::sys::mman::munlock(ptr, region.len()) };
        }
    }
    #[cfg(windows)]
    {
        // SAFETY: this is the same still-live allocation passed to VirtualLock.
        let _ = unsafe {
            windows_sys::Win32::System::Memory::VirtualUnlock(region.as_ptr().cast(), region.len())
        };
    }
}

/// Zeroize a scratch buffer in place. Thin named wrapper so call sites read
/// as intent ("this held plaintext") rather than mechanics.
pub fn wipe(buf: &mut [u8]) {
    buf.zeroize();
}

/// Zeroize and drop a plaintext Vec.
pub fn wipe_vec(mut buf: Vec<u8>) {
    buf.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_secret_is_nonzero_and_unique() {
        let a = SecretBytes::random(32).unwrap();
        let b = SecretBytes::random(32).unwrap();
        assert_eq!(a.as_slice().len(), 32);
        assert_ne!(a.as_slice(), b.as_slice());
        assert_ne!(a.as_slice(), &[0u8; 32]);
        // mlock may legitimately fail under a 0 RLIMIT_MEMLOCK; just make
        // sure querying doesn't blow up either way.
        let _ = a.is_locked();
    }

    #[test]
    fn wipe_clears_buffers() {
        let mut buf = b"plaintext".to_vec();
        wipe(&mut buf);
        assert!(buf.iter().all(|&b| b == 0));
        wipe_vec(b"more plaintext".to_vec());
    }

    #[test]
    fn empty_regions_are_not_locked() {
        assert!(!lock_region(&[]));
    }
}
