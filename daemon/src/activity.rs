//! Output-activity classification, moved daemon-side so the server never needs
//! to see PTY bytes to know an agent "did something" (trust Phase 2).
//!
//! Faithful port of the former server-side classifier
//! (`server/spawn_server/ws/activity.py`): strip terminal control noise
//! (OSC/CSI/charset escapes, the tmux status-bar clock, control chars), and
//! treat output as *meaningful* only if ≥3 non-whitespace characters remain.
//! The daemon runs this locally and emits a content-free `agent.activity`
//! control frame; the server just stamps `last_output_at`.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

/// Throttle: at most one activity ping per agent per this interval.
pub const OUTPUT_TOUCH_INTERVAL: Duration = Duration::from_secs(2);
/// After local input, suppress the echo from counting as agent work.
pub const INPUT_ECHO_SUPPRESS_WINDOW: Duration = Duration::from_millis(750);
/// After an injected resize/redraw, suppress the resulting repaint.
pub const REDRAW_SUPPRESS_WINDOW: Duration = Duration::from_millis(1500);

const MIN_MEANINGFUL_OUTPUT_CHARS: usize = 3;

static OSC_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\].*?(?:\x07|\x1b\\)").unwrap());
static CSI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
static CHARSET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b[()][A-Za-z0-9]").unwrap());
static TMUX_CLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\[spawn-[^\r\n]*?)?(?:"[^\r\n"]+"\s+)?\d{2}:\d{2}\s+\d{2}-[A-Za-z]{3}-\d{2}"#)
        .unwrap()
});
static TMUX_FRAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[spawn-[^\r\n]*").unwrap());
static CONTROL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f]").unwrap());

/// True if this output chunk represents meaningful agent work rather than
/// cursor moves, redraw noise, or the tmux status-bar clock ticking.
pub fn output_is_meaningful(payload: &[u8]) -> bool {
    let text = String::from_utf8_lossy(payload);
    let text = OSC_RE.replace_all(text.as_ref(), "");
    let text = CSI_RE.replace_all(text.as_ref(), "");
    let text = CHARSET_RE.replace_all(text.as_ref(), "");
    let text = TMUX_CLOCK_RE.replace_all(text.as_ref(), "");
    let text = TMUX_FRAG_RE.replace_all(text.as_ref(), "");
    let text = CONTROL_RE.replace_all(text.as_ref(), "");
    text.chars().filter(|c| !c.is_whitespace()).count() >= MIN_MEANINGFUL_OUTPUT_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_output_is_meaningful() {
        assert!(output_is_meaningful(b"hello world"));
        assert!(output_is_meaningful(b"$ ls -la\r\nfile.txt\r\n"));
    }

    #[test]
    fn control_only_output_is_not_meaningful() {
        // Cursor position + clear-line + color reset — pure redraw noise.
        assert!(!output_is_meaningful(b"\x1b[2;5H\x1b[K\x1b[0m"));
        assert!(!output_is_meaningful(b"\x1b[H\x1b[J"));
        // Below the 3-char floor.
        assert!(!output_is_meaningful(b"ok"));
        assert!(!output_is_meaningful(b"\r\n \t"));
    }

    #[test]
    fn tmux_status_clock_is_not_meaningful() {
        assert!(!output_is_meaningful(b"[spawn-oem] \"bash\" 12:34 15-Jul-26"));
    }

    #[test]
    fn osc_title_only_is_not_meaningful() {
        assert!(!output_is_meaningful(b"\x1b]0;my terminal title\x07"));
    }
}
