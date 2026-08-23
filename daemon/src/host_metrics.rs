//! Host capacity: what this machine *is*, and how hard it is currently working.
//!
//! Two audiences, deliberately given two different resolutions, because they
//! carry very different privacy weight (docs/TRUST.md):
//!
//! * **The server**, over `register` and `host.heartbeat`. It gets the static
//!   spec — cores, memory, CPU model, GPU — collected once, plus utilization
//!   as a *bucket* in `0..=5` rather than a number. A five-level reading every
//!   thirty seconds is enough to draw a meter and useless as a behavioural
//!   trace; a per-second percentage would be a fingerprint of when its owner
//!   works, sleeps, builds and trains.
//! * **The browser**, over the `spawn.host.ctl` DataChannel (`host.metrics`).
//!   It gets the exact sample, at whatever rate it asks for, end-to-end from
//!   the daemon with no server code path in between. Precision lives on the
//!   connection that the control plane cannot read.
//!
//! `SPAWND_NO_TELEMETRY=1` disables both — spec and sample both report `None`,
//! the heartbeat carries no buckets, and `host.metrics` is never advertised.
//! It follows the shape of `SPAWND_NO_CPU_SCOPES` in `cpu_scopes.rs`: one
//! environment variable, checked once, no partial modes.

use std::sync::{Mutex as StdMutex, OnceLock, PoisonError, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{MemoryRefreshKind, RefreshKind, System};

/// Set to any value to stop the daemon reporting capacity anywhere.
pub const NO_TELEMETRY_ENV: &str = "SPAWND_NO_TELEMETRY";

/// sysinfo needs two CPU refreshes at least this far apart before the usage it
/// reports means anything. Samples closer together than this reuse the last
/// reading rather than returning the zero a too-eager refresh would produce.
const MIN_CPU_INTERVAL: Duration = Duration::from_millis(220);

/// Highest meter segment. The UI draws five blocks, so a reading is `0..=5`
/// where 0 is "idle enough to be worth saying so".
pub const MAX_BUCKET: u8 = 5;

/// Anything under this reads as bucket 0 rather than as one lit segment: an
/// otherwise idle machine should not look like it is doing something.
const IDLE_PERCENT: f32 = 2.5;

pub fn enabled() -> bool {
    std::env::var_os(NO_TELEMETRY_ENV).is_none()
}

/// What the machine is. Collected once — nothing here changes while the daemon
/// runs, and re-reading it per heartbeat would buy nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostSpec {
    /// Logical CPUs, which is what a scheduler actually hands out.
    pub cpu_cores: u16,
    /// Physical cores when the platform will say; absent rather than guessed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_physical_cores: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_model: Option<String>,
    pub memory_bytes: u64,
    /// Best-effort and frequently absent: discrete-GPU names come from
    /// `nvidia-smi`, and on an SoC the interesting name is already the CPU
    /// model ("Apple M3 Max"), so there is nothing separate to report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<String>,
}

/// What the machine is doing, exactly. Only ever leaves over `spawn.host.ctl`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostSample {
    /// Whole-machine CPU use, 0–100, across all logical cores.
    pub cpu_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    /// 1-minute load average where the platform keeps one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_one: Option<f32>,
    pub uptime_seconds: u64,
}

impl HostSample {
    pub fn memory_percent(&self) -> f32 {
        if self.memory_total_bytes == 0 {
            return 0.0;
        }
        (self.memory_used_bytes as f64 / self.memory_total_bytes as f64 * 100.0) as f32
    }

    /// The pair the heartbeat carries. Deliberately lossy.
    pub fn buckets(&self) -> (u8, u8) {
        (bucket(self.cpu_percent), bucket(self.memory_percent()))
    }
}

/// Percent to meter segment. Saturating at both ends, NaN-safe, and biased so
/// that "some work is happening" lights exactly one block rather than none.
pub fn bucket(percent: f32) -> u8 {
    if !percent.is_finite() || percent < IDLE_PERCENT {
        return 0;
    }
    let step = (percent / 20.0).ceil();
    if step < 1.0 {
        return 1;
    }
    if step >= f32::from(MAX_BUCKET) {
        return MAX_BUCKET;
    }
    step as u8
}

struct Cached {
    sample: HostSample,
    taken_at: Instant,
}

pub struct Sampler {
    system: StdMutex<System>,
    spec: OnceLock<HostSpec>,
    /// Filled in by a one-shot probe that must never delay startup, so it is
    /// separate from `spec` and folded in when the spec is read.
    gpu: RwLock<Option<String>>,
    last: StdMutex<Option<Cached>>,
}

static SAMPLER: OnceLock<Sampler> = OnceLock::new();

/// The process-wide sampler. Cheap to call; the first call pays for one full
/// sysinfo refresh so that the sample after it reports real CPU usage.
pub fn sampler() -> &'static Sampler {
    SAMPLER.get_or_init(Sampler::new)
}

impl Sampler {
    fn new() -> Self {
        let mut system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(sysinfo::CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        // Priming read: sysinfo's first CPU figure is always zero, and a
        // daemon that has just started is exactly when someone is looking.
        system.refresh_cpu_usage();
        Self {
            system: StdMutex::new(system),
            spec: OnceLock::new(),
            gpu: RwLock::new(None),
            last: StdMutex::new(None),
        }
    }

    /// Start the one-shot GPU probe. Spawned rather than awaited: `nvidia-smi`
    /// on a busy machine can take a second, and nothing may wait on it.
    pub fn probe_gpu(&'static self) {
        if !enabled() {
            return;
        }
        tokio::spawn(async move {
            if let Some(name) = discover_gpu().await {
                if let Ok(mut slot) = self.gpu.write() {
                    *slot = Some(name);
                }
            }
        });
    }

    pub fn spec(&self) -> Option<HostSpec> {
        if !enabled() {
            return None;
        }
        let mut spec = self
            .spec
            .get_or_init(|| {
                let system = self
                    .system
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let cpus = system.cpus();
                HostSpec {
                    cpu_cores: u16::try_from(cpus.len()).unwrap_or(u16::MAX),
                    cpu_physical_cores: System::physical_core_count()
                        .and_then(|count| u16::try_from(count).ok()),
                    cpu_model: cpus
                        .first()
                        .map(|cpu| cpu.brand().trim().to_owned())
                        .filter(|brand| !brand.is_empty()),
                    memory_bytes: system.total_memory(),
                    gpu: None,
                }
            })
            .clone();
        spec.gpu = self.gpu.read().ok().and_then(|slot| slot.clone());
        Some(spec)
    }

    /// One reading. Returns the cached reading when called again inside
    /// sysinfo's minimum CPU interval, so a fast poller gets a stale-but-true
    /// number instead of a fresh zero.
    pub fn sample(&self) -> Option<HostSample> {
        if !enabled() {
            return None;
        }
        {
            let last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(cached) = last.as_ref() {
                if cached.taken_at.elapsed() < MIN_CPU_INTERVAL {
                    return Some(cached.sample);
                }
            }
        }
        let sample = {
            let mut system = self.system.lock().unwrap_or_else(PoisonError::into_inner);
            system.refresh_cpu_usage();
            system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
            HostSample {
                cpu_percent: system.global_cpu_usage().clamp(0.0, 100.0),
                memory_used_bytes: system.used_memory(),
                memory_total_bytes: system.total_memory(),
                load_one: {
                    let average = System::load_average();
                    // Windows reports zeros here rather than an error; every
                    // platform spawnd supports keeps a real one.
                    (average.one > 0.0).then_some(average.one as f32)
                },
                uptime_seconds: System::uptime(),
            }
        };
        if let Ok(mut last) = self.last.lock() {
            *last = Some(Cached {
                sample,
                taken_at: Instant::now(),
            });
        }
        Some(sample)
    }

    /// The heartbeat's pair, or `(None, None)` when telemetry is off or the
    /// platform gave us nothing.
    pub fn heartbeat_buckets(&self) -> (Option<u8>, Option<u8>) {
        match self.sample() {
            Some(sample) => {
                let (cpu, memory) = sample.buckets();
                (Some(cpu), Some(memory))
            }
            None => (None, None),
        }
    }
}

/// Best-effort discrete-GPU name. Never fails loudly and never blocks: a host
/// with no `nvidia-smi` simply reports no GPU, which is also true of every Mac.
async fn discover_gpu() -> Option<String> {
    let output = tokio::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let names: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let first = *names.first()?;
    // "2× NVIDIA GeForce RTX 4090" reads better than four identical lines, and
    // a mixed rig is rare enough to be worth naming only its first card.
    let label = if names.len() > 1 && names.iter().all(|name| *name == first) {
        format!("{}\u{d7} {first}", names.len())
    } else {
        first.to_owned()
    };
    Some(label.chars().take(64).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_reads_as_no_lit_segments() {
        assert_eq!(bucket(0.0), 0);
        assert_eq!(bucket(2.4), 0);
    }

    #[test]
    fn any_real_work_lights_exactly_one_segment() {
        assert_eq!(bucket(2.5), 1);
        assert_eq!(bucket(19.9), 1);
        assert_eq!(bucket(20.0), 1);
    }

    #[test]
    fn segments_climb_one_per_fifth_and_saturate() {
        assert_eq!(bucket(20.1), 2);
        assert_eq!(bucket(41.0), 3);
        assert_eq!(bucket(61.0), 4);
        assert_eq!(bucket(81.0), 5);
        assert_eq!(bucket(100.0), MAX_BUCKET);
        assert_eq!(bucket(140.0), MAX_BUCKET);
    }

    #[test]
    fn a_nonsense_reading_is_never_a_lit_meter() {
        assert_eq!(bucket(f32::NAN), 0);
        assert_eq!(bucket(f32::NEG_INFINITY), 0);
        assert_eq!(bucket(-4.0), 0);
        // Infinity included: a meter pinned by a garbage reading would be a
        // lie in the loudest colour the UI has. Real samples are clamped to
        // 0..=100 before they ever reach here, so this is pure belt-and-braces.
        assert_eq!(bucket(f32::INFINITY), 0);
    }

    #[test]
    fn memory_percent_survives_a_host_that_reports_no_memory() {
        let sample = HostSample {
            cpu_percent: 10.0,
            memory_used_bytes: 0,
            memory_total_bytes: 0,
            load_one: None,
            uptime_seconds: 0,
        };
        assert_eq!(sample.memory_percent(), 0.0);
        assert_eq!(sample.buckets(), (1, 0));
    }

    #[test]
    fn buckets_are_the_only_thing_the_heartbeat_could_carry() {
        let sample = HostSample {
            cpu_percent: 87.3,
            memory_used_bytes: 48,
            memory_total_bytes: 64,
            load_one: Some(9.5),
            uptime_seconds: 1,
        };
        // 87.3% CPU and 75% memory both survive as a segment count and
        // nothing finer — the point of the pair.
        assert_eq!(sample.buckets(), (5, 4));
    }
}
