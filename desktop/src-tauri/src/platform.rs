#[cfg(target_os = "macos")]
pub const THIS_COMPUTER: &str = "this Mac";
#[cfg(target_os = "windows")]
pub const THIS_COMPUTER: &str = "this PC";

#[cfg(target_os = "macos")]
pub const THIS_COMPUTER_CAPITALIZED: &str = "This Mac";
#[cfg(target_os = "windows")]
pub const THIS_COMPUTER_CAPITALIZED: &str = "This PC";

#[cfg(target_os = "macos")]
pub const DEVICE_LABEL: &str = "SPAWN D on Mac";
#[cfg(target_os = "windows")]
pub const DEVICE_LABEL: &str = "SPAWN D on Windows";
