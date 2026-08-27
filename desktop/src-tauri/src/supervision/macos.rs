use std::process::Command;

use serde_json::Value;

pub(super) fn diagnostics(status: &Value) -> (String, String) {
    let service_name = status
        .pointer("/instances/0/service/name")
        .and_then(Value::as_str);
    let service = launchctl_status(service_name);
    let log_tail = service_name.map(log_tail).unwrap_or_default();
    (service, log_tail)
}

fn launchctl_status(service_name: Option<&str>) -> String {
    let Some(service_name) = service_name else {
        return "service name unavailable".into();
    };
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    let Some(uid) = uid else {
        return "could not resolve launchctl user domain".into();
    };
    let label = service_name
        .strip_prefix("launchd ")
        .unwrap_or(service_name);
    Command::new("launchctl")
        .arg("print")
        .arg(format!("gui/{uid}/{label}"))
        .output()
        .map(|output| super::combine_output(&output))
        .unwrap_or_else(|error| format!("launchctl print failed: {error}"))
}

fn log_tail(service_name: &str) -> String {
    let Some(instance) = service_name.strip_prefix("launchd app.spawn.spawnd.") else {
        return String::new();
    };
    let Some(home) = dirs::home_dir() else {
        return String::new();
    };
    let state_dir = dirs::state_dir()
        .unwrap_or_else(|| home.join(".local/state"))
        .join("spawn")
        .join(instance);
    ["spawnd.out.log", "spawnd.err.log"]
        .into_iter()
        .filter_map(|name| {
            let path = state_dir.join(name);
            let bytes = std::fs::read(&path).ok()?;
            let text = String::from_utf8_lossy(&bytes);
            let lines = text.lines().rev().take(60).collect::<Vec<_>>();
            Some(format!(
                "{name}\n{}",
                lines.into_iter().rev().collect::<Vec<_>>().join("\n")
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
