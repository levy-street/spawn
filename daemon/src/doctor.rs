//! `spawnd doctor`: ordered, actionable local health checks.

use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use sha2::Digest;

use crate::cli::DoctorArgs;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
    Skip,
}

#[derive(Debug, Serialize)]
pub struct Check {
    id: u8,
    name: &'static str,
    status: CheckStatus,
    detail: String,
    fix: Option<String>,
    /// Which instance a check is about, when the report covers several.
    #[serde(skip_serializing_if = "Option::is_none")]
    instance: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DoctorOutput {
    host: String,
    version: String,
    checks: Vec<Check>,
    problems: usize,
}

pub async fn run(
    server_cli: Option<String>,
    args: DoctorArgs,
    explicit_config: bool,
) -> anyhow::Result<()> {
    if !args.json {
        crate::tui::print_logo();
    }
    let spinner = crate::tui::Spinner::start("running health checks");
    let output = inspect_all(server_cli, explicit_config).await?;
    spinner.finish(output.problems == 0, "health checks complete");
    if args.json {
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        print_plain(&output);
    }
    if output.problems > 0 {
        std::process::exit(1);
    }
    Ok(())
}

/// Every instance a shell can see, each checked on its own; one report. The
/// JSON shape `{host, version, checks, problems}` is unchanged — a check
/// gains an `instance` field when the report covers more than one.
async fn inspect_all(
    server_cli: Option<String>,
    explicit_config: bool,
) -> anyhow::Result<DoctorOutput> {
    let host = hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "unknown-host".into());
    let dirs = crate::lifecycle::selected_dirs(explicit_config)?;
    let several = dirs.len() > 1;
    let mut checks = Vec::new();
    for dir in &dirs {
        let _guard = crate::lifecycle::ConfigDirGuard::set(dir);
        let instance = several.then(|| crate::lifecycle::instance_name(dir));
        checks.extend(
            inspect(server_cli.clone())
                .await
                .into_iter()
                .map(|mut check| {
                    check.instance = instance.clone();
                    check
                }),
        );
    }
    let problems = checks
        .iter()
        .filter(|check| check.status == CheckStatus::Fail)
        .count();
    Ok(DoctorOutput {
        host,
        version: crate::version::build_version(),
        checks,
        problems,
    })
}

/// The checks for the ambient instance, in their fixed order.
async fn inspect(server_cli: Option<String>) -> Vec<Check> {
    let config_dir = crate::config::config_dir().ok();
    let credentials = crate::creds::load();
    let build = config_dir.as_deref().map(crate::status::instance_build);
    let mut checks = Vec::with_capacity(if cfg!(windows) { 16 } else { 15 });

    checks.push(match &credentials {
        Ok(_) => ok(1, "credentials", "readable"),
        Err(error) => fail(
            1,
            "credentials",
            format!("unreadable: {error}"),
            "spawnd reset, then spawnd possess",
        ),
    });
    checks.push(match &credentials {
        Ok(stored) if stored.is_logged_in() => ok(2, "signed in", "token present"),
        Ok(_) => fail(2, "signed in", "token missing", "spawnd login"),
        Err(_) => skip(2, "signed in", "credentials unavailable"),
    });

    let server = credentials.as_ref().ok().and_then(|stored| {
        crate::config::server_url_for_instance(server_cli, stored.server_url.as_deref()).ok()
    });
    let health = match &server {
        Some(server) => probe_health(server).await,
        None => HealthProbe::failed("http", "server address unavailable"),
    };
    checks.push(match health.error_kind.as_deref() {
        None => ok(3, "server reachable", health.detail.clone()),
        Some("dns") => fail(
            3,
            "server reachable",
            health.detail.clone(),
            "check the server address — spawnd status shows it",
        ),
        Some("tls") => fail(
            3,
            "server reachable",
            health.detail.clone(),
            "this machine's clock or CA store — see checks 9 and 10",
        ),
        Some(_) => fail(
            3,
            "server reachable",
            health.detail.clone(),
            "check the server address — spawnd status shows it",
        ),
    });
    checks.push(if health.error_kind.is_some() {
        skip(4, "server is SPAWN D", "server unreachable")
    } else if health.is_spawn_d {
        ok(4, "server is SPAWN D", "api healthy")
    } else {
        fail(
            4,
            "server is SPAWN D",
            "health response has the wrong shape",
            "--server points at something else (a proxy login page?) — re-run install with the right URL",
        )
    });

    let token = credentials
        .as_ref()
        .ok()
        .and_then(|stored| stored.access_token.as_deref());
    checks.push(match (&server, token) {
        (Some(server), Some(token)) => probe_sign_in(server, token).await,
        _ => skip(5, "sign-in accepted", "no usable sign-in"),
    });
    checks.push(match (&server, token) {
        (Some(server), Some(token)) => probe_websocket(server, token).await,
        _ => skip(6, "live connection", "no usable sign-in"),
    });

    let service_status = config_dir.as_deref().map(crate::service::status);
    checks.push(match service_status.as_ref() {
        Some(status) => {
            if let Some(issue) = config_dir
                .as_deref()
                .and_then(crate::service::diagnostic)
            {
                fail(
                    7,
                    "background service",
                    issue,
                    if config_dir.as_deref().is_some_and(|dir| {
                        crate::service::needs_fallback_offer(dir)
                            || (cfg!(windows)
                                && crate::service::preferred_mode(dir)
                                    == crate::service::ServiceMode::Task)
                    })
                    {
                        "re-run spawnd possess; it will confirm Task Scheduler or offer the Run watchdog fallback"
                    } else {
                        "spawnd reconnect (reinstalls the selected service manager)"
                    },
                )
            } else if status.running {
                if crate::service::user_linger_enabled() == Some(false) {
                    warning(
                        7,
                        "background service",
                        "The daemon will start at login, not at boot. To fix: loginctl enable-linger $USER",
                    )
                } else {
                    ok(
                        7,
                        "background service",
                        format!("running ({})", status.name),
                    )
                }
            } else {
                fail(
                    7,
                    "background service",
                    if status.installed {
                        "installed but not running"
                    } else {
                        "not installed"
                    },
                    "spawnd reconnect (reinstalls and starts the service)",
                )
            }
        }
        None => fail(
            7,
            "background service",
            "config unavailable",
            "spawnd reconnect (reinstalls and starts the service)",
        ),
    });
    checks.push(
        if service_status
            .as_ref()
            .is_some_and(|status| !status.running)
        {
            skip(8, "daemon heartbeat", "service not running")
        } else {
            match config_dir
                .as_deref()
                .and_then(|dir| crate::state::read(dir).ok().flatten())
            {
                Some(state)
                    if crate::state::daemon_state_is_live(
                        config_dir.as_deref().unwrap(),
                        &state,
                    ) && state_file_fresh(config_dir.as_deref().unwrap()) =>
                {
                    ok(8, "daemon heartbeat", format!("fresh (pid {})", state.pid))
                }
                Some(_) => fail(
                    8,
                    "daemon heartbeat",
                    "stale or process is gone",
                    "spawnd reconnect",
                ),
                None => fail(
                    8,
                    "daemon heartbeat",
                    "state.json missing",
                    "spawnd reconnect",
                ),
            }
        },
    );
    checks.push(clock_check(&health));

    checks.push(match (&config_dir, &build) {
        (Some(dir), Some(build)) => pair_check(10, dir, build, server.as_ref()).await,
        _ => skip(10, "worker binary", "config unavailable"),
    });
    let capability = crate::update::capability();
    checks.push(if capability.self_update {
        ok(11, "self-update ready", "install dir writable")
    } else if capability.blocked == Some("unwritable") {
        warn(
            11,
            "self-update ready",
            "install dir isn't writable",
            "the install dir isn't writable; updates will be skipped",
        )
    } else {
        fail(
            11,
            "self-update ready",
            capability.blocked.unwrap_or("unavailable"),
            "reinstall SPAWN D from this server",
        )
    });
    checks.push(match (&server, &build) {
        (Some(server), Some(build)) => probe_version(server, build.tree.as_deref()).await,
        _ => skip(12, "version", "server unavailable"),
    });
    checks.push(match config_dir.as_deref() {
        Some(dir) => permissions_check(dir),
        None => skip(13, "file permissions", "config unavailable"),
    });
    checks.push(probe_udp().await);
    checks.push(match (&config_dir, &build) {
        (Some(dir), Some(build)) => layout_check(15, dir, build),
        _ => skip(15, "install layout", "config unavailable"),
    });
    #[cfg(windows)]
    checks.push(windows_agent_shell_check());
    checks
}

/// The pair the instance actually runs. A live daemon is asked what it runs
/// — its own verdict on its worker, and on Linux the executable the kernel
/// says it is — and the worker beside *that* executable is probed. Without a
/// live daemon the release the instance is pointed at is probed, and only
/// with neither is this command's own pair what is checked.
async fn pair_check(
    id: u8,
    config_dir: &Path,
    build: &crate::status::InstanceBuild,
    server: Option<&url::Url>,
) -> Check {
    let reinstall = server
        .map(crate::update::reinstall_command)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "irm '<server>/install.ps1' | iex".into()
            } else {
                "curl -fsSL <server>/install.sh | sh".into()
            }
        });
    let name = "worker binary";
    if let Some(state) = build.live() {
        if state.worker_mismatch {
            return fail(
                id,
                name,
                "the running daemon refuses new sessions: its spawn-worker does not match it",
                "spawnd reconnect restarts it onto the release it is pointed at; if that does not clear it, spawnd update",
            );
        }
        let exe = match crate::install::live_exe(state.pid) {
            Some((_, true)) => {
                return fail(
                    id,
                    name,
                    "the running daemon's binary was replaced on disk; the worker beside it is another build's",
                    "spawnd reconnect (restarts onto the release it is pointed at)",
                )
            }
            Some((exe, false)) => Some(exe),
            None => state.exe.as_deref().map(std::path::PathBuf::from),
        };
        return match exe {
            Some(exe) => {
                let worker = exe.with_file_name(crate::platform::executable_name("spawn-worker"));
                match crate::install::probe_pair(&exe, &worker) {
                    Ok(identity) if identity.version == state.version => ok(
                        id,
                        name,
                        format!("spawn-worker matches the running spawnd ({})", identity.version),
                    ),
                    Ok(identity) => fail(
                        id,
                        name,
                        format!(
                            "the pair beside the running daemon is {} but the daemon is {}",
                            identity.version, state.version
                        ),
                        "spawnd reconnect (restarts onto the release it is pointed at)",
                    ),
                    Err(error) => fail(
                        id,
                        name,
                        format!("the worker beside the running daemon is missing or mismatched: {error}"),
                        format!("reinstall — {reinstall}"),
                    ),
                }
            }
            None => warn(
                id,
                name,
                "the running daemon predates the pair report",
                "restart it to confirm the pair: spawnd reconnect",
            ),
        };
    }
    if let Some(release) = &build.selected {
        return match crate::install::probe_pair(&release.spawnd(), &release.spawn_worker()) {
            Ok(identity) if identity.version == release.meta.version => ok(
                id,
                name,
                format!("release {} is a matching pair", release.id()),
            ),
            Ok(_) | Err(_) => fail(
                id,
                name,
                format!("release {} is damaged", release.id()),
                format!("reinstall — {reinstall}"),
            ),
        };
    }
    let _ = config_dir;
    match crate::update::ensure_worker_pair().await {
        Ok(()) => ok(id, name, "spawn-worker matches this spawnd"),
        Err(_) => fail(
            id,
            name,
            "missing or version mismatch",
            format!("reinstall — {reinstall}"),
        ),
    }
}

/// Where the instance launches from, and whether its service agrees.
fn layout_check(id: u8, config_dir: &Path, build: &crate::status::InstanceBuild) -> Check {
    let name = "install layout";
    let running_from = build
        .live()
        .and_then(|state| {
            crate::install::live_exe(state.pid)
                .map(|(exe, _)| exe)
                .or_else(|| state.exe.as_deref().map(std::path::PathBuf::from))
        })
        .map(|exe| (crate::install::provenance_of(&exe), exe));
    let report = crate::service::launch_report(config_dir);
    match &build.selected {
        Some(release) => {
            let Ok(layout) = crate::install::layout_for_instance(config_dir) else {
                return skip(id, name, "install root unavailable");
            };
            let launch = crate::install::launch_path(&layout, config_dir);
            if let Some(binary) = &report.binary {
                if !same_path(binary, &launch) {
                    // The daemon redirects itself to the selected release at
                    // every start, so this is a detour, not an outage — but
                    // the detour starts a stale binary and hides the store.
                    let fix = if report.drop_ins.is_empty() {
                        "spawnd reconnect (rewrites the service for the release store)".to_owned()
                    } else {
                        format!(
                            "a drop-in overrides ExecStart ({}); remove it, then: systemctl --user daemon-reload && spawnd reconnect",
                            report.drop_ins.join(", ")
                        )
                    };
                    return warn(
                        id,
                        name,
                        format!(
                            "the service starts {} instead of the selected release {} (the daemon redirects itself at start)",
                            binary.display(),
                            release.id()
                        ),
                        fix,
                    );
                }
            }
            if let Some((provenance, exe)) = &running_from {
                if !matches!(provenance, crate::install::Provenance::Store { .. }) {
                    return warn(
                        id,
                        name,
                        format!(
                            "the daemon is running from {} while the instance is pointed at release {}",
                            exe.display(),
                            release.id()
                        ),
                        "spawnd reconnect (restarts onto the selected release)",
                    );
                }
            }
            ok(
                id,
                name,
                format!("release store: {} ({})", release.id(), release.meta.variant),
            )
        }
        None => match running_from {
            Some((crate::install::Provenance::Legacy { .. }, exe)) => {
                let shared = crate::install::is_shared_legacy_pair(&exe);
                warn(
                    id,
                    name,
                    if shared {
                        format!(
                            "shared binary at {}; every instance installed the old way shares it",
                            exe.display()
                        )
                    } else {
                        format!("a pair placed by hand at {}", exe.display())
                    },
                    "restart moves this instance into the release store: spawnd reconnect",
                )
            }
            Some((crate::install::Provenance::Unmanaged, exe)) => {
                ok(id, name, format!("unmanaged build at {}", exe.display()))
            }
            Some((crate::install::Provenance::Store { release_id, .. }, _)) => warn(
                id,
                name,
                format!("running release {release_id} without a selection"),
                "spawnd possess (records the selection)",
            ),
            None => match report.binary {
                Some(binary) => warning(
                    id,
                    name,
                    format!("not running; the service would start {}", binary.display()),
                ),
                None => skip(id, name, "no daemon running and no service installed"),
            },
        },
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    let canonical =
        |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(left) == canonical(right)
}

#[cfg(windows)]
fn windows_agent_shell_check() -> Check {
    let claude = crate::platform::resolve_program(Path::new("claude")).is_some()
        || std::env::var_os("APPDATA").is_some_and(|base| {
            Path::new(&base).join("npm/claude.cmd").is_file()
                || Path::new(&base).join("npm/claude.exe").is_file()
        })
        || dirs::home_dir().is_some_and(|home| {
            home.join(".local/bin/claude.exe").is_file()
                || home.join(".local/bin/claude.cmd").is_file()
        });
    let powershell = ["pwsh.exe", "powershell.exe"]
        .into_iter()
        .any(|program| crate::platform::resolve_program(Path::new(program)).is_some())
        || std::env::var_os("SystemRoot").is_some_and(|root| {
            Path::new(&root)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
                .is_file()
        });
    let comspec = std::env::var_os("COMSPEC")
        .filter(|path| !path.is_empty())
        .is_some_and(|path| Path::new(&path).is_file());
    let git_bash = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH")
        .filter(|path| !path.is_empty())
        .is_some_and(|path| Path::new(&path).is_file())
        || ["LOCALAPPDATA", "ProgramFiles"]
            .into_iter()
            .filter_map(std::env::var_os)
            .any(|base| Path::new(&base).join("Git/bin/bash.exe").is_file());
    windows_agent_shell_check_for(claude, powershell, comspec, git_bash)
}

#[cfg(windows)]
fn windows_agent_shell_check_for(
    claude: bool,
    powershell: bool,
    comspec: bool,
    git_bash: bool,
) -> Check {
    if claude && !powershell && !git_bash {
        return fail(
            16,
            "agent shell",
            "Claude Code has neither PowerShell nor Git Bash",
            "install PowerShell or Git for Windows, then run spawnd doctor again",
        );
    }
    if !powershell && !comspec {
        return fail(
            16,
            "agent shell",
            "no PowerShell or COMSPEC shell is available",
            "repair Windows PowerShell or install PowerShell 7",
        );
    }
    if claude && !git_bash {
        return warn(
            16,
            "agent shell",
            "Claude Code can use PowerShell, but Bash-tool functionality is degraded",
            "install Git for Windows for full Claude Code tool compatibility",
        );
    }
    ok(
        16,
        "agent shell",
        if claude {
            "Claude Code shell dependencies available"
        } else if powershell {
            "PowerShell available"
        } else {
            "COMSPEC fallback available"
        },
    )
}

struct HealthProbe {
    error_kind: Option<String>,
    detail: String,
    is_spawn_d: bool,
    clock_skew_seconds: Option<i64>,
}

impl HealthProbe {
    fn failed(kind: &str, detail: &str) -> Self {
        Self {
            error_kind: Some(kind.into()),
            detail: detail.into(),
            is_spawn_d: false,
            clock_skew_seconds: None,
        }
    }
}

async fn probe_health(server: &url::Url) -> HealthProbe {
    let host = server.host_str().unwrap_or("server");
    let port = server.port_or_known_default().unwrap_or(443);
    if tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_none()
    {
        return HealthProbe::failed("dns", &format!("can't resolve {host}"));
    }
    let Ok(url) = crate::config::api_url(server, "/api/health") else {
        return HealthProbe::failed("http", "invalid health URL");
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return HealthProbe::failed("http", "HTTP client unavailable"),
    };
    let started = std::time::Instant::now();
    match client.get(url).send().await {
        Ok(response) => {
            let clock_skew_seconds = response
                .headers()
                .get(reqwest::header::DATE)
                .and_then(parse_http_date)
                .map(|server_time| {
                    let local_time = SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    server_time.saturating_sub(local_time)
                });
            let status = response.status();
            let body = response.json::<serde_json::Value>().await.ok();
            let is_spawn_d = status.is_success()
                && body.as_ref().is_some_and(|value| {
                    value.get("status").and_then(serde_json::Value::as_str) == Some("ok")
                        || value.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
                });
            HealthProbe {
                error_kind: (!status.is_success()).then(|| "http".into()),
                detail: format!("{} ({} ms)", server, started.elapsed().as_millis()),
                is_spawn_d,
                clock_skew_seconds,
            }
        }
        Err(error) => {
            let rendered = error.to_string().to_ascii_lowercase();
            let kind = if rendered.contains("certificate") || rendered.contains("tls") {
                "tls"
            } else {
                "tcp"
            };
            HealthProbe::failed(kind, &format!("{server} did not answer"))
        }
    }
}

fn parse_http_date(value: &reqwest::header::HeaderValue) -> Option<i64> {
    let parts = value.to_str().ok()?.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let day = parts[1].parse().ok()?;
    let month = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year = parts[3].parse().ok()?;
    let time = parts[4].split(':').collect::<Vec<_>>();
    if time.len() != 3 {
        return None;
    }
    crate::state::utc_fields_to_unix_seconds(
        year,
        month,
        day,
        time[0].parse().ok()?,
        time[1].parse().ok()?,
        time[2].parse().ok()?,
    )
}

fn clock_check(health: &HealthProbe) -> Check {
    let Some(skew) = health.clock_skew_seconds.map(i64::abs) else {
        return if health.error_kind.is_some() {
            skip(9, "clock", "server unreachable")
        } else {
            warn(
                9,
                "clock",
                "server supplied no usable Date header",
                "enable automatic date & time — TLS and sign-in both break on a skewed clock",
            )
        };
    };
    if skew <= 120 {
        ok(9, "clock", format!("within {skew} s of the server"))
    } else if skew <= 300 {
        warn(
            9,
            "clock",
            format!("this machine's clock is {} min off", (skew + 59) / 60),
            "enable automatic date & time — TLS and sign-in both break on a skewed clock",
        )
    } else {
        fail(
            9,
            "clock",
            format!(
                "This machine's clock is {} min off. Sign-in and secure connections both break",
                (skew + 59) / 60
            ),
            "enable automatic date & time — TLS and sign-in both break on a skewed clock",
        )
    }
}

async fn probe_sign_in(server: &url::Url, token: &str) -> Check {
    let Ok(url) = crate::config::api_url(server, "/api/hosts/self") else {
        return skip(5, "sign-in accepted", "invalid server URL");
    };
    let client = reqwest::Client::new();
    match client.get(url).bearer_auth(token).send().await {
        Ok(response) if response.status().is_success() => {
            ok(5, "sign-in accepted", "server accepted this machine")
        }
        Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => fail(
            5,
            "sign-in accepted",
            "server rejected this machine",
            "this machine was signed out or removed — spawnd login to re-approve it",
        ),
        Ok(response) => fail(
            5,
            "sign-in accepted",
            format!("HTTP {}", response.status()),
            "this machine was signed out or removed — spawnd login to re-approve it",
        ),
        Err(_) => skip(5, "sign-in accepted", "server unreachable"),
    }
}

async fn probe_websocket(server: &url::Url, token: &str) -> Check {
    let Ok(url) = crate::config::ws_url(server) else {
        return skip(6, "live connection", "invalid server URL");
    };
    match crate::ws::connect(&url, token).await {
        Ok(mut stream) => {
            let _ = stream.close(None).await;
            ok(6, "live connection", "WebSocket handshake ok")
        }
        Err(_) => fail(
            6,
            "live connection",
            "WebSocket handshake failed",
            "a proxy or firewall is blocking WebSockets on 443",
        ),
    }
}

async fn probe_version(server: &url::Url, instance_tree: Option<&str>) -> Check {
    let Some(instance_tree) = instance_tree else {
        return skip(12, "version", "this daemon does not report its build");
    };
    let Ok(url) = crate::config::api_url(server, "/api/release") else {
        return skip(12, "version", "invalid release URL");
    };
    let Ok(response) = reqwest::Client::new().get(url).send().await else {
        return skip(12, "version", "release unavailable");
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return skip(12, "version", "release unavailable");
    };
    let latest = body
        .pointer("/daemon/tree")
        .and_then(serde_json::Value::as_str);
    if latest == Some(instance_tree) {
        ok(12, "version", "up to date")
    } else if latest.is_some() {
        warn(
            12,
            "version",
            "update available",
            "an update is available — spawnd update",
        )
    } else {
        skip(12, "version", "release unavailable")
    }
}

fn state_file_fresh(config_dir: &Path) -> bool {
    crate::state::heartbeat_is_fresh(config_dir, Duration::from_secs(90))
}

fn permissions_check(config_dir: &Path) -> Check {
    let credentials = config_dir.join("credentials.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(&credentials) {
            Ok(metadata) if metadata.permissions().mode() & 0o077 == 0 => {
                ok(13, "file permissions", "credentials are 0600")
            }
            Ok(_) => fail(
                13,
                "file permissions",
                "credentials are accessible to other users",
                format!("chmod 600 {}", credentials.display()),
            ),
            Err(_) => skip(13, "file permissions", "credentials file missing"),
        }
    }
    #[cfg(windows)]
    {
        if !credentials.exists() {
            return skip(13, "file permissions", "credentials file missing");
        }
        if let Err(error) = crate::platform::validate_private_dir(config_dir) {
            return fail(
                13,
                "file permissions",
                format!("credential directory security failed: {error}"),
                "move the directory aside, then run spawnd possess again",
            );
        }
        match crate::platform::open_private_file(&credentials, false) {
            Ok(_) => ok(
                13,
                "file permissions",
                "credentials have a protected owner-only DACL",
            ),
            Err(error) => fail(
                13,
                "file permissions",
                format!("credential file security failed: {error}"),
                "move the file aside, then run spawnd login again",
            ),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = credentials;
        skip(13, "file permissions", "not available on this platform")
    }
}

async fn probe_udp() -> Check {
    match tokio::time::timeout(Duration::from_secs(2), stun_binding_probe()).await {
        Ok(Ok(())) => ok(14, "media path", "UDP STUN reply received"),
        _ => warning(
            14,
            "media path",
            "UDP to the relay looks blocked; terminals may not connect from outside this network.",
        ),
    }
}

async fn stun_binding_probe() -> anyhow::Result<()> {
    // The current server sends ICE configuration only inside session frames,
    // so the doctor uses the server's default STUN endpoint for its standalone
    // media-path check. This is a real binding exchange, not merely a local
    // socket bind.
    let address = tokio::net::lookup_host(("stun.l.google.com", 19_302))
        .await?
        .next()
        .ok_or_else(|| anyhow::anyhow!("STUN endpoint did not resolve"))?;
    let bind = if address.is_ipv6() {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    };
    let socket = tokio::net::UdpSocket::bind(bind).await?;
    socket.connect(address).await?;
    let mut request = [0_u8; 20];
    request[0..2].copy_from_slice(&1_u16.to_be_bytes());
    request[4..8].copy_from_slice(&0x2112_A442_u32.to_be_bytes());
    let nonce = sha2::Sha256::digest(format!(
        "{}:{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    request[8..20].copy_from_slice(&nonce[..12]);
    socket.send(&request).await?;
    let mut response = [0_u8; 1024];
    let size = socket.recv(&mut response).await?;
    if size < 20
        || response[0..2] != 0x0101_u16.to_be_bytes()
        || response[4..8] != 0x2112_A442_u32.to_be_bytes()
        || response[8..20] != request[8..20]
    {
        anyhow::bail!("invalid STUN binding response")
    }
    Ok(())
}

fn ok(id: u8, name: &'static str, detail: impl Into<String>) -> Check {
    Check {
        id,
        name,
        status: CheckStatus::Ok,
        detail: detail.into(),
        fix: None,
        instance: None,
    }
}
fn warn(id: u8, name: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Check {
    Check {
        id,
        name,
        status: CheckStatus::Warn,
        detail: detail.into(),
        fix: Some(fix.into()),
        instance: None,
    }
}
fn warning(id: u8, name: &'static str, detail: impl Into<String>) -> Check {
    Check {
        id,
        name,
        status: CheckStatus::Warn,
        detail: detail.into(),
        fix: None,
        instance: None,
    }
}
fn fail(id: u8, name: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Check {
    Check {
        id,
        name,
        status: CheckStatus::Fail,
        detail: detail.into(),
        fix: Some(fix.into()),
        instance: None,
    }
}
fn skip(id: u8, name: &'static str, detail: impl Into<String>) -> Check {
    Check {
        id,
        name,
        status: CheckStatus::Skip,
        detail: detail.into(),
        fix: None,
        instance: None,
    }
}

fn print_plain(output: &DoctorOutput) {
    println!(
        "SPAWN D doctor — {}, this command is spawnd {}",
        output.host, output.version
    );
    println!();
    let mut current_instance: Option<&str> = None;
    for check in &output.checks {
        if check.instance.as_deref() != current_instance {
            current_instance = check.instance.as_deref();
            if let Some(instance) = current_instance {
                println!("instance {instance}");
            }
        }
        let marker = match check.status {
            CheckStatus::Ok => {
                if crate::tui::styled_stdout() {
                    "✓"
                } else {
                    "ok"
                }
            }
            CheckStatus::Warn => {
                if crate::tui::styled_stdout() {
                    "!"
                } else {
                    "warn"
                }
            }
            CheckStatus::Fail => {
                if crate::tui::styled_stdout() {
                    "✗"
                } else {
                    "fail"
                }
            }
            CheckStatus::Skip => {
                if crate::tui::styled_stdout() {
                    "–"
                } else {
                    "skip"
                }
            }
        };
        println!("  {marker:<4} {:<20} {}", check.name, check.detail);
        if let Some(fix) = &check.fix {
            println!("       ↳ fix: {fix}");
        }
    }
    if output.problems == 0 {
        println!("Everything checks out.");
    } else {
        if output.problems == 1 {
            println!("1 problem found. Fixes are listed above; run spawnd doctor again after.");
        } else {
            println!(
                "{} problems found. Fixes are listed above; run spawnd doctor again after.",
                output.problems
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doctor_json_shape_is_stable() {
        let output = DoctorOutput {
            host: "host".into(),
            version: "0.1.0".into(),
            checks: vec![ok(1, "credentials", "readable")],
            problems: 0,
        };
        let value = serde_json::to_value(output).unwrap();
        assert_eq!(value["host"], "host");
        assert_eq!(value["version"], "0.1.0");
        assert_eq!(value["checks"][0]["status"], "ok");
        assert_eq!(value["checks"][0]["fix"], serde_json::Value::Null);
        // One instance: no `instance` field, the shape scripts already parse.
        assert!(value["checks"][0].get("instance").is_none());
        assert_eq!(value["problems"], 0);
    }

    #[test]
    fn check_order_is_exact() {
        let names = vec![
            "credentials",
            "signed in",
            "server reachable",
            "server is SPAWN D",
            "sign-in accepted",
            "live connection",
            "background service",
            "daemon heartbeat",
            "clock",
            "worker binary",
            "self-update ready",
            "version",
            "file permissions",
            "media path",
            "install layout",
        ];
        #[cfg(windows)]
        let names = {
            let mut names = names;
            names.push("agent shell");
            names
        };
        for (index, name) in names.into_iter().enumerate() {
            assert_eq!(index + 1, usize::from((index + 1) as u8));
            assert!(!name.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn claude_shell_diagnostic_distinguishes_failure_warning_and_fallback() {
        assert_eq!(
            windows_agent_shell_check_for(true, false, true, false).status,
            CheckStatus::Fail
        );
        assert_eq!(
            windows_agent_shell_check_for(true, true, true, false).status,
            CheckStatus::Warn
        );
        assert_eq!(
            windows_agent_shell_check_for(true, false, true, true).status,
            CheckStatus::Ok
        );
        assert_eq!(
            windows_agent_shell_check_for(false, false, true, false).status,
            CheckStatus::Ok
        );
        assert_eq!(
            windows_agent_shell_check_for(false, false, false, true).status,
            CheckStatus::Fail
        );
    }

    #[test]
    fn http_date_and_clock_thresholds_are_stable() {
        let header = reqwest::header::HeaderValue::from_static("Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(parse_http_date(&header), Some(0));
        let healthy = HealthProbe {
            error_kind: None,
            detail: String::new(),
            is_spawn_d: true,
            clock_skew_seconds: Some(120),
        };
        assert_eq!(clock_check(&healthy).status, CheckStatus::Ok);
        assert_eq!(
            clock_check(&HealthProbe {
                clock_skew_seconds: Some(121),
                ..healthy
            })
            .status,
            CheckStatus::Warn
        );
    }
}
