//! Small terminal presentation kit with a byte-stable plain mode.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anstyle::{AnsiColor, Effects, Style};

pub fn styled_stdout() -> bool {
    presentation_enabled(
        std::io::stdout().is_terminal(),
        std::env::var_os("NO_COLOR").is_some(),
    )
}

pub fn styled_stderr() -> bool {
    presentation_enabled(
        std::io::stderr().is_terminal(),
        std::env::var_os("NO_COLOR").is_some(),
    )
}

fn presentation_enabled(is_tty: bool, no_color: bool) -> bool {
    is_tty && !no_color
}

pub fn print_logo() {
    if !styled_stdout() || terminal_columns() < 60 {
        return;
    }
    let logo = if utf8_locale() {
        UNICODE_LOGO
    } else {
        ASCII_LOGO
    };
    let accent = Style::new().fg_color(Some(AnsiColor::Red.into()));
    let mut out = anstream::stdout();
    for line in logo.lines() {
        let _ = writeln!(out, "{accent}{line}{accent:#}");
    }
}

pub fn step_line(current: usize, total: usize, text: &str) -> String {
    format!("spawn: [{current}/{total}] {text}")
}

pub fn confirm(prompt: &str) -> std::io::Result<bool> {
    if !std::io::stdin().is_terminal() {
        return Ok(false);
    }
    let mut stdout = std::io::stdout().lock();
    write!(stdout, "{prompt} [y/N] ")?;
    stdout.flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

pub struct Spinner {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    started: Instant,
    active: bool,
    label: String,
}

impl Spinner {
    pub fn start(label: &str) -> Self {
        let active = styled_stderr();
        let stop = Arc::new(AtomicBool::new(false));
        let thread = active.then(|| {
            let stop = Arc::clone(&stop);
            let label = label.to_owned();
            thread::spawn(move || {
                const FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
                let mut frame = 0;
                let mut stderr = anstream::stderr();
                while !stop.load(Ordering::Acquire) {
                    let _ = write!(stderr, "\rspawn: {} {label}", FRAMES[frame]);
                    let _ = stderr.flush();
                    frame = (frame + 1) % FRAMES.len();
                    thread::sleep(Duration::from_millis(80));
                }
            })
        });
        Self {
            stop,
            thread,
            started: Instant::now(),
            active,
            label: label.to_owned(),
        }
    }

    pub fn finish(mut self, ok: bool, label: &str) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if self.active {
            let glyph = if ok { "✓" } else { "✗" };
            let color = if ok { AnsiColor::Green } else { AnsiColor::Red };
            let style = Style::new()
                .fg_color(Some(color.into()))
                .effects(Effects::BOLD);
            let mut stderr = anstream::stderr();
            let _ = writeln!(
                stderr,
                "\r\x1b[2Kspawn: {style}{glyph}{style:#} {label} ({:.1}s)",
                self.started.elapsed().as_secs_f32()
            );
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
            if self.active {
                let style = Style::new()
                    .fg_color(Some(AnsiColor::Red.into()))
                    .effects(Effects::BOLD);
                let mut stderr = anstream::stderr();
                let _ = writeln!(
                    stderr,
                    "\r\x1b[2Kspawn: {style}✗{style:#} {} ({:.1}s)",
                    self.label,
                    self.started.elapsed().as_secs_f32()
                );
            }
        }
    }
}

fn terminal_columns() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(80)
}

fn utf8_locale() -> bool {
    for name in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Ok(value) = std::env::var(name) {
            if value.is_empty() {
                continue;
            }
            let upper = value.to_ascii_uppercase();
            return upper.contains("UTF-8") || upper.contains("UTF8");
        }
    }
    true
}

const UNICODE_LOGO: &str = r#"            .  ·  ✦  ·  .
        ·                   ·
     ·        \  |  /          ·
    ·          \ | /            ·
   ·        ─── \|/ ───          ·      S P A W N  D
   ·             |               ·      ──────────────
   ·             |               ·      your machine, possessed
    ·           /|\             ·
     ·      ── ┘ | └ ──        ·
        ·        |          ·
            ·  ·  ✦  ·  ·"#;

const ASCII_LOGO: &str = r#"            .  *  +  *  .
        .                   .
     .        \  |  /          .
    .          \ | /            .
   .        --- \|/ ---          .      S P A W N  D
   .             |               .      --------------
   .             |               .      your machine, possessed
    .           /|\             .
     .      -- / | \ --        .
        .        |          .
            .  .  +  .  ."#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_step_text_is_the_pre_tui_text_with_only_the_required_prefix() {
        assert!(!presentation_enabled(false, false));
        assert!(!presentation_enabled(true, true));
        assert_eq!(
            step_line(1, 2, "Registering this machine"),
            "spawn: [1/2] Registering this machine"
        );
    }

    #[test]
    fn both_logos_fit_the_contract() {
        for logo in [UNICODE_LOGO, ASCII_LOGO] {
            assert!(logo.lines().count() <= 12);
            assert!(logo.lines().all(|line| line.chars().count() <= 80));
        }
    }
}
