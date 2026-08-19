//! Best-effort GPU detection, reported once at registration.
//!
//! Three rules, because this runs on every host anyone possesses and none of
//! it is worth a failed login:
//!
//!   1. **Never fatal.** Every probe is allowed to be missing, slow, or to
//!      print something unexpected. The answer is `None` and the host
//!      registers exactly as it does today.
//!   2. **Bounded.** Each subprocess goes through the same timeout+capture
//!      path tool detection already uses, so a wedged `nvidia-smi` cannot
//!      hold a reconnect open.
//!   3. **Cached.** Probed once per process. Hardware does not change under a
//!      running daemon, and a reconnect loop must not re-shell out.
//!
//! What is *not* here: anything that identifies the machine beyond the class
//! of hardware in it. Adapter model and VRAM, no serials, no UUIDs.

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Long enough for a cold `nvidia-smi`, short enough not to stall a register.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
/// A model string is a label, not a payload.
const MAX_NAME_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuInfo {
    /// Structured so the UI can pick a mark; anything unrecognized is "other".
    pub vendor: GpuVendor,
    /// The adapter model, verbatim from the platform, for the tooltip.
    pub name: String,
    /// Absent on integrated and unified-memory parts, where it is meaningless.
    pub vram_mb: Option<u32>,
    /// Total adapters found, so a multi-GPU box can render "+N".
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Other,
}

impl GpuVendor {
    /// Classify from a model string. Deliberately conservative: an unknown
    /// vendor renders as a neutral chip rather than the wrong logo.
    pub fn from_name(name: &str) -> Self {
        let lower = name.to_ascii_lowercase();
        if lower.contains("nvidia")
            || lower.contains("geforce")
            || lower.contains("quadro")
            || lower.contains("tesla")
            || lower.contains("rtx")
            || lower.contains("gtx")
        {
            GpuVendor::Nvidia
        } else if lower.contains("amd")
            || lower.contains("radeon")
            || lower.contains("instinct")
            || lower.contains("ati ")
        {
            GpuVendor::Amd
        } else if lower.contains("intel") || lower.contains("arc ") || lower.contains("iris") {
            GpuVendor::Intel
        } else if lower.contains("apple") {
            GpuVendor::Apple
        } else {
            GpuVendor::Other
        }
    }

    /// PCI vendor id from `/sys/class/drm/*/device/vendor`.
    fn from_pci_id(id: &str) -> Option<Self> {
        match id.trim().trim_start_matches("0x").to_ascii_lowercase().as_str() {
            "10de" => Some(GpuVendor::Nvidia),
            "1002" | "1022" => Some(GpuVendor::Amd),
            "8086" => Some(GpuVendor::Intel),
            "106b" => Some(GpuVendor::Apple),
            _ => None,
        }
    }
}

/// One detected adapter, before the pick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adapter {
    pub vendor: GpuVendor,
    pub name: String,
    pub vram_mb: Option<u32>,
}

/// Highest-VRAM adapter wins; ties keep detection order. The `+N` in the UI
/// comes from the count, so nothing is hidden — just not shown at a glance.
pub fn pick(adapters: Vec<Adapter>) -> Option<GpuInfo> {
    let count = u32::try_from(adapters.len()).unwrap_or(u32::MAX);
    let best = adapters
        .into_iter()
        .enumerate()
        .max_by_key(|(index, adapter)| (adapter.vram_mb.unwrap_or(0), usize::MAX - index))
        .map(|(_, adapter)| adapter)?;
    Some(GpuInfo {
        vendor: best.vendor,
        name: truncate_name(&best.name),
        vram_mb: best.vram_mb,
        count,
    })
}

fn truncate_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.chars().count() <= MAX_NAME_LEN {
        return trimmed.to_string();
    }
    trimmed.chars().take(MAX_NAME_LEN).collect()
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
pub fn parse_nvidia_smi(output: &str) -> Vec<Adapter> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let (name, memory) = line.split_once(',')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            Some(Adapter {
                vendor: GpuVendor::Nvidia,
                name: name.to_string(),
                // `nounits` gives plain MiB; anything else is not a number and
                // simply means "unknown VRAM", not "no GPU".
                vram_mb: memory.trim().parse::<u32>().ok(),
            })
        })
        .collect()
}

/// `system_profiler SPDisplaysDataType -json`. Apple Silicon reports the
/// integrated GPU with no VRAM figure, which is the honest answer for unified
/// memory — the badge shows the part, not an invented number.
pub fn parse_system_profiler(output: &str) -> Vec<Adapter> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(output) else {
        return Vec::new();
    };
    let Some(items) = root.get("SPDisplaysDataType").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let name = item
                .get("sppci_model")
                .or_else(|| item.get("_name"))
                .and_then(|v| v.as_str())?
                .trim();
            if name.is_empty() {
                return None;
            }
            let vram_mb = item
                .get("spdisplays_vram")
                .or_else(|| item.get("_spdisplays_vramActive"))
                .and_then(|v| v.as_str())
                .and_then(parse_vram_text);
            Some(Adapter {
                vendor: GpuVendor::from_name(name),
                name: name.to_string(),
                vram_mb,
            })
        })
        .collect()
}

/// "8 GB" / "1536 MB", as `system_profiler` writes it.
fn parse_vram_text(value: &str) -> Option<u32> {
    let value = value.trim();
    let (number, unit) = value.split_once(' ')?;
    let amount: f64 = number.trim().parse().ok()?;
    let mb = match unit.trim().to_ascii_uppercase().as_str() {
        "GB" | "GIB" => amount * 1024.0,
        "MB" | "MIB" => amount,
        _ => return None,
    };
    if !mb.is_finite() || mb <= 0.0 {
        return None;
    }
    Some(mb.round() as u32)
}

/// Read what sysfs knows. No subprocess at all, so this is the cheap fallback
/// for the Linux boxes where nothing NVIDIA is installed.
#[cfg(target_os = "linux")]
fn probe_linux_sysfs() -> Vec<Adapter> {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return Vec::new();
    };
    let mut adapters = Vec::new();
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        // cardN only: cardN-HDMI-A-1 and friends are connectors, not adapters.
        .filter(|name| {
            name.starts_with("card") && name["card".len()..].chars().all(|c| c.is_ascii_digit())
        })
        .collect();
    names.sort();
    for name in names {
        let device = format!("/sys/class/drm/{name}/device");
        let Ok(vendor_id) = std::fs::read_to_string(format!("{device}/vendor")) else {
            continue;
        };
        let Some(vendor) = GpuVendor::from_pci_id(&vendor_id) else {
            continue;
        };
        // AMD exposes VRAM in bytes here; nobody else does, and that is fine.
        let vram_mb = std::fs::read_to_string(format!("{device}/mem_info_vram_total"))
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .map(|bytes| (bytes / (1024 * 1024)) as u32)
            .filter(|mb| *mb > 0);
        adapters.push(Adapter {
            vendor,
            name: sysfs_adapter_name(vendor, &name),
            vram_mb,
        });
    }
    adapters
}

#[cfg(target_os = "linux")]
fn sysfs_adapter_name(vendor: GpuVendor, card: &str) -> String {
    // No model string is available without lspci/hwdata, so name the vendor
    // and the card rather than inventing a model.
    let vendor = match vendor {
        GpuVendor::Nvidia => "NVIDIA",
        GpuVendor::Amd => "AMD",
        GpuVendor::Intel => "Intel",
        GpuVendor::Apple => "Apple",
        GpuVendor::Other => "GPU",
    };
    format!("{vendor} ({card})")
}

#[cfg(not(target_os = "linux"))]
fn probe_linux_sysfs() -> Vec<Adapter> {
    Vec::new()
}

/// Probe once per process. `None` means "no GPU, or we could not tell" — the
/// two are indistinguishable from here and must render identically (absent).
pub async fn detect<F, Fut>(run_capture: F) -> Option<GpuInfo>
where
    F: Fn(&'static str, Vec<&'static str>) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let mut adapters = Vec::new();

    if let Some(output) = run_capture(
        "nvidia-smi",
        vec![
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
    )
    .await
    {
        adapters.extend(parse_nvidia_smi(&output));
    }

    if cfg!(target_os = "macos") && adapters.is_empty() {
        if let Some(output) =
            run_capture("system_profiler", vec!["SPDisplaysDataType", "-json"]).await
        {
            adapters.extend(parse_system_profiler(&output));
        }
    }

    if adapters.is_empty() {
        adapters.extend(probe_linux_sysfs());
    }

    pick(adapters)
}

static CACHED: OnceLock<Option<GpuInfo>> = OnceLock::new();

/// The process-wide cached answer, probing on first call.
pub async fn detect_cached() -> Option<GpuInfo> {
    if let Some(cached) = CACHED.get() {
        return cached.clone();
    }
    let detected = detect(|program, args| async move {
        let capture = crate::run::run_program_capture(
            program,
            &args,
            PROBE_TIMEOUT,
            PROBE_OUTPUT_LIMIT,
            None::<&BTreeMap<String, String>>,
        )
        .await;
        capture.success.then_some(capture.output)
    })
    .await;
    CACHED.get_or_init(|| detected).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_smi_rows_become_adapters() {
        let adapters = parse_nvidia_smi(
            "NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3090, 24576\n\n",
        );
        assert_eq!(adapters.len(), 2);
        assert_eq!(adapters[0].vendor, GpuVendor::Nvidia);
        assert_eq!(adapters[0].name, "NVIDIA GeForce RTX 4090");
        assert_eq!(adapters[0].vram_mb, Some(24564));
    }

    #[test]
    fn an_unparseable_memory_column_still_yields_the_adapter() {
        // "not supported" is what vGPU and some laptop parts print. That is a
        // GPU we know about with VRAM we do not — not the absence of a GPU.
        let adapters = parse_nvidia_smi("NVIDIA T400, [N/A]\n");
        assert_eq!(adapters.len(), 1);
        assert_eq!(adapters[0].vram_mb, None);
    }

    #[test]
    fn garbage_output_detects_nothing_rather_than_guessing() {
        assert!(parse_nvidia_smi("").is_empty());
        assert!(parse_nvidia_smi("command not found\n").is_empty());
        assert!(parse_system_profiler("<html>nope</html>").is_empty());
        assert!(parse_system_profiler("{}").is_empty());
    }

    #[test]
    fn apple_silicon_reports_its_integrated_gpu_with_no_vram() {
        let adapters = parse_system_profiler(
            r#"{"SPDisplaysDataType":[{"_name":"Apple M2 Pro","sppci_model":"Apple M2 Pro"}]}"#,
        );
        assert_eq!(adapters.len(), 1);
        assert_eq!(adapters[0].vendor, GpuVendor::Apple);
        // Unified memory: no separate VRAM figure exists, so none is invented.
        assert_eq!(adapters[0].vram_mb, None);
    }

    #[test]
    fn a_discrete_mac_gpu_reports_its_vram() {
        let adapters = parse_system_profiler(
            r#"{"SPDisplaysDataType":[{"sppci_model":"AMD Radeon Pro 5500M","spdisplays_vram":"8 GB"}]}"#,
        );
        assert_eq!(adapters[0].vendor, GpuVendor::Amd);
        assert_eq!(adapters[0].vram_mb, Some(8192));
    }

    #[test]
    fn the_highest_vram_adapter_is_the_one_shown_and_the_rest_are_counted() {
        let picked = pick(vec![
            Adapter {
                vendor: GpuVendor::Intel,
                name: "Intel UHD".into(),
                vram_mb: None,
            },
            Adapter {
                vendor: GpuVendor::Nvidia,
                name: "NVIDIA RTX 4090".into(),
                vram_mb: Some(24564),
            },
            Adapter {
                vendor: GpuVendor::Nvidia,
                name: "NVIDIA RTX 3090".into(),
                vram_mb: Some(24576),
            },
        ])
        .expect("an adapter");
        assert_eq!(picked.name, "NVIDIA RTX 3090");
        assert_eq!(picked.count, 3);
    }

    #[test]
    fn no_adapters_means_no_gpu_field_at_all() {
        assert!(pick(Vec::new()).is_none());
    }

    #[test]
    fn sysfs_pci_ids_map_to_the_vendors_we_can_draw() {
        assert_eq!(GpuVendor::from_pci_id("0x10de"), Some(GpuVendor::Nvidia));
        assert_eq!(GpuVendor::from_pci_id("0x1002"), Some(GpuVendor::Amd));
        assert_eq!(GpuVendor::from_pci_id("0x8086"), Some(GpuVendor::Intel));
        assert_eq!(GpuVendor::from_pci_id("0x106b"), Some(GpuVendor::Apple));
        // A non-GPU PCI class under /sys/class/drm is skipped entirely rather
        // than reported as an unknown adapter.
        assert_eq!(GpuVendor::from_pci_id("0x1af4"), None);
        assert_eq!(GpuVendor::from_pci_id("nonsense"), None);
    }

    #[test]
    fn an_unrecognized_vendor_is_other_rather_than_the_wrong_logo() {
        assert_eq!(GpuVendor::from_name("Moore Threads MTT S80"), GpuVendor::Other);
        assert_eq!(GpuVendor::from_name("llvmpipe"), GpuVendor::Other);
        assert_eq!(GpuVendor::from_name("NVIDIA GeForce RTX 4090"), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_name("AMD Radeon RX 7900 XTX"), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_name("Intel Arc A770"), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_name("Apple M3 Max"), GpuVendor::Apple);
    }

    #[test]
    fn an_absurd_model_string_is_bounded() {
        let picked = pick(vec![Adapter {
            vendor: GpuVendor::Other,
            name: "x".repeat(4096),
            vram_mb: None,
        }])
        .expect("an adapter");
        assert_eq!(picked.name.chars().count(), MAX_NAME_LEN);
    }

    #[tokio::test]
    async fn detection_never_fails_when_every_probe_is_missing() {
        let detected = detect(|_program, _args| async { None }).await;
        // On a machine with a real sysfs this may legitimately find something;
        // what must never happen is a panic or an error.
        let _ = detected;
    }

    #[tokio::test]
    async fn nvidia_output_wins_without_consulting_anything_else() {
        let detected = detect(|program, _args| async move {
            match program {
                "nvidia-smi" => Some("NVIDIA H100 PCIe, 81559\n".to_string()),
                other => panic!("probed {other} after nvidia-smi already answered"),
            }
        })
        .await
        .expect("a gpu");
        assert_eq!(detected.vendor, GpuVendor::Nvidia);
        assert_eq!(detected.vram_mb, Some(81559));
        assert_eq!(detected.count, 1);
    }
}
