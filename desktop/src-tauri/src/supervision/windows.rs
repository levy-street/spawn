use std::path::Path;
use std::process::Command;

use serde_json::Value;

const MAX_DIAGNOSTIC_CHARS: usize = 16 * 1024;
const MAX_LOG_BYTES: usize = 256 * 1024;
const LOG_LINES: usize = 60;

pub(super) fn diagnostics(status: &Value) -> (String, String) {
    let service = status.pointer("/instances/0/service");
    let task_name = service
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && *name != "unsupported");
    let manager = service
        .and_then(|value| value.get("manager"))
        .and_then(Value::as_str);
    let diagnostic = match task_name
        .filter(|name| manager == Some("task-scheduler") || name.starts_with('\\'))
    {
        Some(name) => task_scheduler_status(name),
        None => "Task Scheduler name unavailable from spawnd status --json".into(),
    };
    let logs = ["stdout_log", "stderr_log"]
        .into_iter()
        .filter_map(|field| {
            let path = service?.get(field)?.as_str()?;
            tail_file(Path::new(path)).map(|tail| format!("{path}\n{tail}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (diagnostic, logs)
}

fn task_scheduler_status(task_name: &str) -> String {
    let args = task_query_args(task_name);
    match Command::new("schtasks.exe").args(&args).output() {
        Ok(output) => {
            let text = super::combine_output(&output);
            let state = if output.status.success() {
                "success"
            } else {
                "failed"
            };
            sanitize(&format!(
                "schtasks /Query {state} ({}):\n{text}",
                output.status
            ))
        }
        Err(error) => format!("schtasks /Query failed to start: {error}"),
    }
}

fn task_query_args(task_name: &str) -> [&str; 4] {
    ["/Query", "/TN", task_name, "/XML"]
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect()
}

fn tail_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let start = bytes.len().saturating_sub(MAX_LOG_BYTES);
    let text = String::from_utf8_lossy(&bytes[start..]);
    let lines = text.lines().rev().take(LOG_LINES).collect::<Vec<_>>();
    Some(sanitize(
        &lines.into_iter().rev().collect::<Vec<_>>().join("\n"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_query_uses_the_daemon_reported_name_without_localization() {
        assert_eq!(
            task_query_args("\\SPAWN D\\spawnd-deadbeef"),
            ["/Query", "/TN", "\\SPAWN D\\spawnd-deadbeef", "/XML"]
        );
    }

    #[test]
    fn older_status_shapes_are_tolerated() {
        let (service, logs) = diagnostics(&serde_json::json!({"instances": [{}]}));
        assert!(service.contains("unavailable"));
        assert!(logs.is_empty());
    }

    #[test]
    fn diagnostics_are_sanitized_and_bounded() {
        let dirty = format!("ok\0{}", "x".repeat(MAX_DIAGNOSTIC_CHARS + 20));
        let clean = sanitize(&dirty);
        assert!(!clean.contains('\0'));
        assert_eq!(clean.chars().count(), MAX_DIAGNOSTIC_CHARS);
    }
}
