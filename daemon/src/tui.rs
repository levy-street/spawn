//! Terminal presentation kit.
//!
//! Two modes, chosen once from the environment:
//!
//! - **rich** (stdout is a tty and `NO_COLOR` is unset): a fixed-height live
//!   region pinned to the bottom of normal scrollback. Steps update in place;
//!   log lines and static panels scroll above it.
//! - **plain** (piped, redirected, CI, `NO_COLOR`): the byte-stable
//!   `spawn: `-prefixed lines this command has always emitted.
//!
//! The live region deliberately never reads a key. In the flagship onboarding
//! path — `curl … | install.sh | sh` — the shell owns stdin, so the process
//! inherits a pipe and no keyboard is available. Everything here renders; a
//! prompt would hang.
//!
//! One writer owns stdout while a live region exists. Anything printing
//! `println!` alongside it lands mid-frame, which is exactly the interleaving
//! (`waiting for approvalspawn: opened your browser…`) this module replaces.
//! During a `Ui`, route output through `Ui::log`.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

// ---------------------------------------------------------------- glyph sets

/// Box-drawing and status glyphs, so a non-UTF-8 locale still gets a frame
/// instead of mojibake.
#[derive(Clone, Copy)]
pub struct Glyphs {
    pub top_left: &'static str,
    pub top_right: &'static str,
    pub bottom_left: &'static str,
    pub bottom_right: &'static str,
    pub horizontal: &'static str,
    pub vertical: &'static str,
    pub dot: &'static str,
    pub done: &'static str,
    pub failed: &'static str,
    pub running: &'static str,
    pub spinner: &'static [&'static str],
}

const UNICODE_GLYPHS: Glyphs = Glyphs {
    top_left: "┌",
    top_right: "┐",
    bottom_left: "└",
    bottom_right: "┘",
    horizontal: "─",
    vertical: "│",
    dot: "·",
    done: "✓",
    failed: "✗",
    running: ">",
    spinner: &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII_GLYPHS: Glyphs = Glyphs {
    top_left: "+",
    top_right: "+",
    bottom_left: "+",
    bottom_right: "+",
    horizontal: "-",
    vertical: "|",
    dot: ".",
    done: "+",
    failed: "x",
    running: ">",
    spinner: &["|", "/", "-", "\\"],
};

pub fn glyphs() -> Glyphs {
    if utf8_locale() {
        UNICODE_GLYPHS
    } else {
        ASCII_GLYPHS
    }
}

// ------------------------------------------------------------ pure rendering

/// Visible column count, ignoring escape sequences. Panels are padded with
/// this, so a miscount shows up immediately as a ragged right edge.
///
/// Two shapes matter here. CSI (`ESC [ … letter`) carries the colours. OSC
/// (`ESC ] … BEL` or `ESC ] … ESC \\`) carries the clickable-link markers, and
/// its payload is a URL — full of letters that would end a CSI scan early and
/// leave the rest of the URL counted as visible text.
/// A row with every escape sequence removed — what the reader actually sees.
/// Tests assert against this so a styling change never silently rewrites copy.
#[cfg(test)]
pub fn strip_styles(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        // OSC (`ESC ]`) runs to a terminator; CSI and friends end at the first
        // alphabetic byte. Scanning both the same way ate hyperlink payloads.
        if chars.clone().next() == Some(']') {
            let mut previous = None;
            for esc in chars.by_ref() {
                if esc == '\u{7}' || (esc == '\\' && previous == Some('\u{1b}')) {
                    break;
                }
                previous = Some(esc);
            }
        } else {
            for esc in chars.by_ref() {
                if esc.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

pub fn display_width(text: &str) -> usize {
    let mut width = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            width += 1;
            continue;
        }
        match chars.peek() {
            Some(']') => {
                chars.next();
                // Runs to BEL, or to ST (ESC \).
                while let Some(inner) = chars.next() {
                    if inner == '\u{7}' {
                        break;
                    }
                    if inner == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {
                for esc in chars.by_ref() {
                    if esc.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        }
    }
    width
}

/// Wrap `text` so the terminal treats it as a link to `url` (OSC 8).
///
/// Terminals that do not understand OSC 8 — Terminal.app among them — ignore
/// the marker and show the text unchanged, so this is safe to emit
/// unconditionally on a styled stream.
pub fn hyperlink(url: &str, text: &str, styled: bool) -> String {
    if !styled {
        return text.to_owned();
    }
    format!("\u{1b}]8;;{url}\u{1b}\\{text}\u{1b}]8;;\u{1b}\\")
}

fn pad_to(text: &str, width: usize) -> String {
    let visible = display_width(text);
    let mut out = text.to_owned();
    out.push_str(&" ".repeat(width.saturating_sub(visible)));
    out
}

/// A titled box. `rows` may carry SGR escapes; padding accounts for them.
pub fn render_panel(title: &str, rows: &[String], width: usize, styled: bool) -> Vec<String> {
    let g = glyphs();
    let accent = if styled { panel_style() } else { Style::new() };
    let inner = width.saturating_sub(4);
    let mut out = Vec::with_capacity(rows.len() + 2);

    let head = format!("{} [ {} ] ", g.horizontal, title);
    let rule = g
        .horizontal
        .repeat(width.saturating_sub(display_width(&head) + 2));
    out.push(format!(
        "{accent}{}{head}{rule}{}{accent:#}",
        g.top_left, g.top_right
    ));
    for row in rows {
        out.push(format!(
            "{accent}{}{accent:#} {} {accent}{}{accent:#}",
            g.vertical,
            pad_to(row, inner),
            g.vertical
        ));
    }
    out.push(format!(
        "{accent}{}{}{}{accent:#}",
        g.bottom_left,
        g.horizontal.repeat(width.saturating_sub(2)),
        g.bottom_right
    ));
    out
}

/// Hard-wrap unstyled text to `width` columns. Used for approval URLs, which
/// routinely run past any sane frame; they wrapped before the frame existed
/// too, so this is the status quo rather than a new compromise.
pub fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_owned()];
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= width {
        return vec![text.to_owned()];
    }
    chars
        .chunks(width)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

/// Cap a rendered line at `width` visible columns, keeping its SGR escapes.
///
/// This is load-bearing, not cosmetic. A line wider than the terminal wraps
/// onto a second physical row, but the rewind counts logical rows — so the
/// cursor lands a row low, the previous frame's top line survives, and the
/// frame marches down the screen instead of repainting in place.
pub fn truncate_visible(text: &str, width: usize) -> String {
    if display_width(text) <= width {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut seen = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            out.push(ch);
            // OSC payloads are URLs; scanning them for a letter the way CSI is
            // scanned would cut the sequence apart and leak it as text.
            if chars.peek() == Some(&']') {
                out.push(chars.next().expect("peeked"));
                while let Some(inner) = chars.next() {
                    out.push(inner);
                    if inner == '\u{7}' {
                        break;
                    }
                    if inner == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            out.push(chars.next().expect("peeked"));
                        }
                        break;
                    }
                }
                continue;
            }
            for esc in chars.by_ref() {
                out.push(esc);
                if esc.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        if seen == width {
            break;
        }
        out.push(ch);
        seen += 1;
    }
    out.push_str("\u{1b}[0m");
    out
}

/// Word-wrap prose to `width`. Prefer this over [`wrap_plain`] for anything a
/// person reads; `wrap_plain` is for opaque runs — URLs, codes, fingerprints —
/// that have no spaces to break on.
pub fn wrap_words(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_owned()];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        // A single word wider than the frame still has to be broken, or it
        // pushes the border out and the whole panel goes ragged.
        if word.chars().count() > width {
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            lines.extend(wrap_plain(word, width));
            continue;
        }
        let joined = if current.is_empty() {
            word.chars().count()
        } else {
            current.chars().count() + 1 + word.chars().count()
        };
        if joined > width {
            lines.push(std::mem::take(&mut current));
        } else if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StepState {
    Pending,
    Running,
    Done,
    Failed,
}

/// One row of the step list: `✓  2. Register this machine ···· [ DONE ]`.
pub fn render_step(
    state: StepState,
    number: usize,
    label: &str,
    detail: &str,
    width: usize,
    styled: bool,
) -> String {
    let g = glyphs();
    let (mark, colour) = match state {
        StepState::Pending => (" ", AnsiColor::BrightBlack),
        StepState::Running => (g.running, AnsiColor::Red),
        StepState::Done => (g.done, AnsiColor::Green),
        StepState::Failed => (g.failed, AnsiColor::Red),
    };
    let mark_style = if styled {
        Style::new().fg_color(Some(colour.into()))
    } else {
        Style::default()
    };
    let dim = styled.then(dim_style).unwrap_or_default();
    let detail_style = if styled {
        Style::new().fg_color(Some(colour.into()))
    } else {
        Style::default()
    };

    let head = format!("{mark_style}{mark}{mark_style:#}  {number}. {label} ");
    let tail = format!("{detail_style}{detail}{detail_style:#}");
    let dots = width
        .saturating_sub(display_width(&head) + display_width(&tail) + 1)
        .max(1);
    format!("{head}{dim}{}{dim:#} {tail}", g.dot.repeat(dots))
}

fn panel_style() -> Style {
    Style::new().fg_color(Some(AnsiColor::Red.into()))
}

fn dim_style() -> Style {
    Style::new().fg_color(Some(AnsiColor::BrightBlack.into()))
}

pub fn bold(text: &str, styled: bool) -> String {
    if !styled {
        return text.to_owned();
    }
    let style = Style::new().effects(Effects::BOLD);
    format!("{style}{text}{style:#}")
}

pub fn dim(text: &str, styled: bool) -> String {
    if !styled {
        return text.to_owned();
    }
    let style = dim_style();
    format!("{style}{text}{style:#}")
}

pub fn accent(text: &str, styled: bool) -> String {
    if !styled {
        return text.to_owned();
    }
    let style = panel_style();
    format!("{style}{text}{style:#}")
}

// ------------------------------------------------------------------ live UI

struct Step {
    label: String,
    detail: String,
    state: StepState,
}

struct UiState {
    title: String,
    steps: Vec<Step>,
    status: Option<String>,
    hint: String,
    frame: usize,
    /// Lines waiting to be flushed above the live region.
    pending: Vec<String>,
    /// Height of the region as last drawn, so the next frame knows how far up
    /// to move. Zero means nothing is on screen yet.
    drawn: usize,
    width: usize,
    finished: bool,
}

impl UiState {
    fn frame_lines(&self) -> Vec<String> {
        let g = glyphs();
        let rows: Vec<String> = self
            .steps
            .iter()
            .enumerate()
            .map(|(index, step)| {
                render_step(
                    step.state,
                    index + 1,
                    &step.label,
                    &step.detail,
                    self.width.saturating_sub(4),
                    true,
                )
            })
            .collect();
        let mut lines = render_panel(&self.title, &rows, self.width, true);
        let status = match &self.status {
            Some(status) => {
                let spin = g.spinner[self.frame % g.spinner.len()];
                format!("  {} {status}", accent(spin, true))
            }
            None => String::new(),
        };
        // The hint is the expendable half. If both cannot sit on one row with a
        // gap between them, drop the hint rather than let the row wrap — a
        // wrapped row desynchronises every rewind that follows.
        let status_width = display_width(&status);
        let hint_width = self.hint.chars().count();
        let room = status_width + hint_width + MIN_HINT_GAP <= self.width;
        let hint = if room { self.hint.as_str() } else { "" };
        let pad = self
            .width
            .saturating_sub(status_width + hint.chars().count());
        lines.push(format!("{status}{}{}", " ".repeat(pad), dim(hint, true)));
        // Belt and braces: whatever a caller supplied, nothing leaves here wider
        // than the frame.
        lines
            .into_iter()
            .map(|line| truncate_visible(&line, self.width))
            .collect()
    }
}

/// The live region currently owning stdout, if any.
///
/// A process-wide handle rather than a threaded-through parameter: the login
/// ceremony prints from inside a security-sensitive closure with a dozen test
/// call sites, and the alternative is churning all of them to carry a `&Ui`.
/// Only one live region can exist at a time — it owns stdout by definition.
///
/// Lock order is always ACTIVE then the state, never the reverse.
static ACTIVE: Mutex<Option<Arc<Mutex<UiState>>>> = Mutex::new(None);

fn with_active<T>(edit: impl FnOnce(&mut UiState) -> T) -> Option<T> {
    let active = ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = active.as_ref()?;
    let mut state = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.finished {
        return None;
    }
    let out = edit(&mut state);
    draw(&mut state);
    Some(out)
}

/// Emit one line of scrollback. Routes into the live region when one exists,
/// and otherwise prints the byte-stable `spawn: <text>` line this command has
/// always emitted — so piped output is unchanged.
pub fn log_line(text: &str) {
    if with_active(|state| state.pending.push(text.to_owned())).is_none() {
        println!("spawn: {text}");
    }
}

/// Emit pre-formatted scrollback: `rich` when a live region is drawing,
/// `plain` otherwise.
pub fn log_block(rich: Vec<String>, plain: &[String]) {
    let mut rich = Some(rich);
    if with_active(|state| state.pending.extend(rich.take().unwrap_or_default())).is_none() {
        for line in plain {
            println!("{line}");
        }
    }
}

/// A live, non-interactive terminal display. Cheap no-op in plain mode.
pub struct Ui {
    state: Option<Arc<Mutex<UiState>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
    _vt: Option<crate::platform::VtOutputGuard>,
}

impl Ui {
    /// Rich when stdout is a tty, otherwise a plain-line passthrough.
    /// Rich only when the frame is guaranteed to fit. Below `MIN_FRAME_COLUMNS`
    /// every line would wrap, and a wrapped line makes the cursor-up rewind
    /// land in the wrong place — a scrolling smear rather than a live region.
    pub fn start(title: &str, steps: &[&str], hint: &str) -> Self {
        if !styled_stdout() || terminal_width() < MIN_FRAME_COLUMNS {
            return Self {
                state: None,
                stop: Arc::new(AtomicBool::new(true)),
                thread: None,
                _vt: None,
            };
        }
        let Some(vt) = crate::platform::enable_vt_output() else {
            return Self {
                state: None,
                stop: Arc::new(AtomicBool::new(true)),
                thread: None,
                _vt: None,
            };
        };
        let state = Arc::new(Mutex::new(UiState {
            title: title.to_owned(),
            steps: steps
                .iter()
                .map(|label| Step {
                    label: (*label).to_owned(),
                    detail: "[ PENDING ]".to_owned(),
                    state: StepState::Pending,
                })
                .collect(),
            status: None,
            hint: hint.to_owned(),
            frame: 0,
            pending: Vec::new(),
            drawn: 0,
            width: terminal_width(),
            finished: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let state = Arc::clone(&state);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    {
                        let mut state = match state.lock() {
                            Ok(state) => state,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        // Only the spinner needs a clock. With no status there
                        // is nothing to animate, and repainting an identical
                        // frame ten times a second is pure terminal churn.
                        if state.status.is_some() {
                            state.frame = state.frame.wrapping_add(1);
                            draw(&mut state);
                        }
                    }
                    thread::sleep(Duration::from_millis(90));
                }
            })
        };
        *ACTIVE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&state));
        Self {
            state: Some(state),
            stop,
            thread: Some(thread),
            _vt: Some(vt),
        }
    }

    pub fn is_rich(&self) -> bool {
        self.state.is_some()
    }

    fn with<F: FnOnce(&mut UiState)>(&self, edit: F) {
        if let Some(state) = &self.state {
            let mut state = match state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            if state.finished {
                return;
            }
            edit(&mut state);
            draw(&mut state);
        }
    }

    pub fn begin(&self, index: usize, detail: &str) {
        self.with(|state| {
            if let Some(step) = state.steps.get_mut(index) {
                step.state = StepState::Running;
                step.detail = detail.to_owned();
            }
        });
    }

    pub fn complete(&self, index: usize, detail: &str) {
        self.with(|state| {
            if let Some(step) = state.steps.get_mut(index) {
                step.state = StepState::Done;
                step.detail = detail.to_owned();
            }
        });
    }

    pub fn fail(&self, index: usize, detail: &str) {
        self.with(|state| {
            if let Some(step) = state.steps.get_mut(index) {
                step.state = StepState::Failed;
                step.detail = detail.to_owned();
            }
        });
    }

    pub fn status(&self, text: &str) {
        let text = text.to_owned();
        self.with(move |state| state.status = Some(text));
    }

    /// A line of scrollback above the live region. In plain mode this is the
    /// historical `spawn: <text>` line, unchanged.
    pub fn log(&self, text: &str) {
        log_line(text);
    }

    /// Scrollback that is already fully formatted (a panel, a QR code). Plain
    /// mode prints the fallback instead, so piped output stays stable.
    pub fn block(&self, rich: Vec<String>, plain: &[String]) {
        log_block(rich, plain);
    }

    pub fn width(&self) -> usize {
        self.state
            .as_ref()
            .and_then(|state| state.lock().ok().map(|state| state.width))
            .unwrap_or(80)
    }

    /// Draw one last frame and release the terminal.
    pub fn finish(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(state) = &self.state {
            ACTIVE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            let mut state = match state.lock() {
                Ok(state) => state,
                Err(poisoned) => poisoned.into_inner(),
            };
            if state.finished {
                return;
            }
            state.status = None;
            state.hint = String::new();
            draw(&mut state);
            state.finished = true;
            let mut out = anstream::stdout();
            let _ = writeln!(out);
            let _ = out.flush();
        }
    }
}

impl Drop for Ui {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Repaint the live region in place, flushing any queued scrollback above it
/// first. Single writer, so a frame can never be split by another print.
fn draw(state: &mut UiState) {
    let mut out = anstream::stdout();
    // Rewind over the previous frame so it is overwritten rather than repeated.
    if state.drawn > 0 {
        let _ = write!(out, "\r\x1b[{}A", state.drawn);
    }
    // Clearing to end of screen before scrollback keeps a shrinking frame from
    // leaving fragments of the taller one behind.
    let _ = write!(out, "\x1b[0J");
    for line in state.pending.drain(..) {
        let _ = writeln!(out, "{line}");
    }
    let lines = state.frame_lines();
    for line in &lines {
        let _ = writeln!(out, "{line}");
    }
    state.drawn = lines.len();
    let _ = out.flush();
}

// ------------------------------------------------------------------ helpers

pub fn print_logo() {
    if !styled_stdout() || terminal_width() < 60 {
        return;
    }
    let logo = if utf8_locale() {
        UNICODE_LOGO
    } else {
        ASCII_LOGO
    };
    let accent = panel_style();
    let mut out = anstream::stdout();
    // The mark lands between the installer's last line and the first panel.
    // Without real air on both sides it reads as part of whichever is nearer.
    let _ = writeln!(out);
    let _ = writeln!(out);
    for line in logo.lines() {
        let _ = writeln!(out, "{accent}{line}{accent:#}");
    }
    let _ = writeln!(out);
    let _ = writeln!(out);
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

/// A single-line spinner for commands with no step list — `doctor`, `update`.
///
/// It owns the line it is on, so a caller must `finish` before printing
/// anything else. Flows that interleave progress and log lines want [`Ui`].
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
                let frames = glyphs().spinner;
                let mut frame = 0;
                let mut stderr = anstream::stderr();
                while !stop.load(Ordering::Acquire) {
                    let _ = write!(stderr, "\r\x1b[2Kspawn: {} {label}", frames[frame]);
                    let _ = stderr.flush();
                    frame = (frame + 1) % frames.len();
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
            let g = glyphs();
            let glyph = if ok { g.done } else { g.failed };
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
            self.active = false;
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
            if self.active {
                let g = glyphs();
                let style = Style::new()
                    .fg_color(Some(AnsiColor::Red.into()))
                    .effects(Effects::BOLD);
                let mut stderr = anstream::stderr();
                let _ = writeln!(
                    stderr,
                    "\r\x1b[2Kspawn: {style}{}{style:#} {} ({:.1}s)",
                    g.failed,
                    self.label,
                    self.started.elapsed().as_secs_f32()
                );
            }
        }
    }
}

/// Wait for the operator to press Enter. Returns immediately when stdin is not
/// a terminal, so an unattended install never stalls on a prompt nobody sees.
///
/// `install.sh` reattaches /dev/tty before exec'ing the daemon, which is what
/// makes this reachable at all under `curl … | sh`.
pub fn press_enter(prompt: &str) -> bool {
    if !std::io::stdin().is_terminal() {
        return false;
    }
    if !prompt.is_empty() {
        let styled = styled_stdout();
        let mut out = anstream::stdout();
        let _ = write!(out, "  {} ", dim(prompt, styled));
        let _ = out.flush();
    }
    let mut line = String::new();
    // EOF (the terminal went away mid-prompt) reads as "did not ask for it".
    let answered = matches!(std::io::stdin().read_line(&mut line), Ok(n) if n > 0);
    // The terminal echoed the Enter that ended the read: one row.
    frame_pushed_down(1);
    answered
}

/// Tell the live region the cursor moved down `lines` rows outside `draw`.
///
/// Anything writing to the terminal outside `draw` — a prompt, and the newline
/// the terminal echoes when the reader answers one — leaves the cursor lower
/// than the frame put it. Rewinding by the old height from there lands
/// *inside* the previous frame and repaints on top of it, which is how one
/// frame becomes three marching down the screen.
///
/// Forgetting the height instead (the old `drawn = 0`) avoided the smear but
/// abandoned the frame: it stayed on screen for ever while a second one
/// printed below, so answering a single prompt left two live regions in the
/// scrollback. Counting the rows keeps exactly one, because the next rewind
/// reaches the real top of the frame again.
pub fn frame_pushed_down(lines: usize) {
    let _ = with_active(|state| {
        // Nothing drawn yet means nothing to rewind over; adding to zero would
        // send the next rewind up into output the frame does not own.
        if state.drawn > 0 {
            state.drawn += lines;
        }
    });
}

/// Read one line, showing `default` and returning it when the answer is empty.
/// Returns `default` untouched when stdin is not a terminal.
pub fn prompt_line(prompt: &str, default: &str) -> String {
    if !std::io::stdin().is_terminal() {
        return default.to_owned();
    }
    let styled = styled_stdout();
    let mut out = anstream::stdout();
    let _ = write!(
        out,
        "  {} {} ",
        prompt,
        dim(&format!("[{default}]"), styled)
    );
    let _ = out.flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return default.to_owned();
    }
    // The prompt occupied the row the frame would next be rewound over, and
    // the answer's Enter ended it: one row.
    frame_pushed_down(1);
    let answer = line.trim();
    if answer.is_empty() {
        default.to_owned()
    } else {
        answer.to_owned()
    }
}

/// One row of a pick list.
///
/// Deliberately not [`render_step`]: a progress row shows *state* (its label
/// stays legible whether the step is pending or done), while a pick row shows
/// *focus* — everything on the unselected rows recedes, label included, so the
/// eye lands on the choice without hunting for the marker.
pub fn render_choice_row(
    selected: bool,
    number: usize,
    label: &str,
    detail: &str,
    width: usize,
    styled: bool,
) -> String {
    let g = glyphs();
    let marker = if selected { g.running } else { " " };
    let (marker_style, label_style, detail_style) = if selected {
        (
            Style::new().fg_color(Some(AnsiColor::Red.into())),
            Style::new()
                .fg_color(Some(AnsiColor::White.into()))
                .effects(Effects::BOLD),
            Style::new().fg_color(Some(AnsiColor::Red.into())),
        )
    } else {
        let grey = Style::new().fg_color(Some(AnsiColor::BrightBlack.into()));
        (grey, grey, grey)
    };
    let (marker_style, label_style, detail_style) = if styled {
        (marker_style, label_style, detail_style)
    } else {
        (Style::new(), Style::new(), Style::new())
    };
    let dots_style = if styled { dim_style() } else { Style::new() };

    // A row wider than its frame pushes the border out and the whole panel goes
    // ragged — the failure the status line used to have. Both halves here can
    // be longer than they look: a label may be an operator-supplied origin, and
    // a narrow terminal shrinks the frame around both. So the row is built to
    // fit, trimming the label first and then the detail, rather than trusting
    // either to be short.
    let lead = format!("{marker}  {number}. ");
    let lead_width = display_width(&lead);
    // Reserve what always follows the label even with no detail at all: the
    // space that closes it, one dot, and the space before the (empty) tail.
    let label = truncate_visible(label, width.saturating_sub(lead_width + 3));
    let head = format!(
        "{marker_style}{marker}{marker_style:#}  {label_style}{number}. {label}{label_style:#} "
    );
    let head_width = lead_width + display_width(&label) + 1;
    // What is left after one dot and the space before the detail.
    let detail_room = width.saturating_sub(head_width + 2);
    let detail = truncate_visible(detail, detail_room);
    let tail = if detail.is_empty() {
        String::new()
    } else {
        format!("{detail_style}{detail}{detail_style:#}")
    };
    let dots = width
        .saturating_sub(head_width + display_width(&detail) + 1)
        .max(1);
    format!(
        "{head}{dots_style}{}{dots_style:#} {tail}",
        g.dot.repeat(dots)
    )
}

/// A pick list driven by the arrow keys, with Enter to confirm.
///
/// Falls back to typing a number when raw mode is unavailable, and to
/// `default_index` with no prompt at all when stdin is not a terminal.
pub fn prompt_choice(title: &str, options: &[(&str, &str)], default_index: usize) -> usize {
    let default_index = default_index.min(options.len().saturating_sub(1));
    if !std::io::stdin().is_terminal() || options.is_empty() {
        return default_index;
    }
    let Some(raw) = crate::platform::enable_raw_mode() else {
        return numbered_choice(title, options, default_index);
    };
    let Some(vt) = crate::platform::enable_vt_output() else {
        return numbered_choice(title, options, default_index);
    };
    arrow_choice(title, options, default_index, raw, vt)
}

fn choice_frame(
    title: &str,
    options: &[(&str, &str)],
    selected: usize,
    hint: &str,
    styled: bool,
) -> Vec<String> {
    let width = terminal_width();
    let rows: Vec<String> = options
        .iter()
        .enumerate()
        .map(|(index, (label, blurb))| {
            render_choice_row(
                index == selected,
                index + 1,
                label,
                blurb,
                width.saturating_sub(4),
                styled,
            )
        })
        .collect();
    let mut lines = render_panel(title, &rows, width, styled);
    lines.push(truncate_visible(&format!("  {}", dim(hint, styled)), width));
    lines
}

fn arrow_choice(
    title: &str,
    options: &[(&str, &str)],
    default_index: usize,
    raw: crate::platform::RawModeGuard,
    vt: crate::platform::VtOutputGuard,
) -> usize {
    use std::io::Read;
    let styled = styled_stdout();
    let g = glyphs();
    let hint = if utf8_locale() {
        "↑ ↓ to choose · Enter to confirm"
    } else {
        "up/down to choose, Enter to confirm"
    };
    let _ = g;
    let mut selected = default_index;
    let mut drawn = 0usize;
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 8];

    loop {
        let lines = choice_frame(title, options, selected, hint, styled);
        {
            let mut out = anstream::stdout();
            if drawn > 0 {
                let _ = write!(out, "\r\x1b[{drawn}A");
            }
            let _ = write!(out, "\x1b[0J");
            // Raw mode turns off the newline-to-CRLF translation, so every
            // line has to carry its own carriage return.
            for line in &lines {
                let _ = write!(out, "{line}\r\n");
            }
            let _ = out.flush();
            drawn = lines.len();
        }

        let read = match stdin.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        match &buf[..read] {
            b"\r" | b"\n" => break,
            // Raw mode suppresses signal generation, so ^C arrives as a byte.
            b"\x03" => {
                drop(raw);
                drop(vt);
                let mut out = anstream::stdout();
                let _ = writeln!(out);
                let _ = out.flush();
                std::process::exit(130);
            }
            b"\x1b[A" | b"k" => selected = (selected + options.len() - 1) % options.len(),
            b"\x1b[B" | b"j" => selected = (selected + 1) % options.len(),
            [digit] if digit.is_ascii_digit() => {
                let pick = usize::from(digit - b'0');
                if pick >= 1 && pick <= options.len() {
                    selected = pick - 1;
                }
            }
            _ => {}
        }
    }
    drop(raw);
    drop(vt);
    selected
}

/// The line-based fallback: no raw mode, so type a number and press Enter.
fn numbered_choice(title: &str, options: &[(&str, &str)], default_index: usize) -> usize {
    let styled = styled_stdout();
    let mut out = anstream::stdout();
    for line in choice_frame(title, options, default_index, "", styled) {
        let _ = writeln!(out, "{line}");
    }
    let _ = out.flush();
    loop {
        let answer = prompt_line("choose", &(default_index + 1).to_string());
        match answer.trim().parse::<usize>() {
            Ok(pick) if pick >= 1 && pick <= options.len() => return pick - 1,
            _ => log_line(&format!("enter a number from 1 to {}", options.len())),
        }
    }
}

/// Panel width: the real terminal if we can read it, clamped so the frame stays
/// readable on a wide monitor and does not wrap on a narrow one.
pub fn terminal_width() -> usize {
    let raw = ioctl_columns()
        .or_else(|| {
            std::env::var("COLUMNS")
                .ok()
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(80);
    raw.clamp(20, MAX_FRAME_COLUMNS)
}

/// Minimum blank columns between the status and its hint. Below this they read
/// as one run-on string (`…30 minctrl-c to stop`), so the hint is dropped.
const MIN_HINT_GAP: usize = 4;

/// Below this the frame cannot fit a step row without wrapping, so the live
/// region stands down and the plain lines are used instead.
pub const MIN_FRAME_COLUMNS: usize = 60;
/// Above this a frame stops reading as a unit on a wide monitor.
const MAX_FRAME_COLUMNS: usize = 92;

fn ioctl_columns() -> Option<usize> {
    crate::platform::terminal_size().map(|(columns, _)| columns as usize)
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

/// The SPAWN D trident, traced from the alpha channel of
/// `desktop/src-tauri/icons/tray@2x.png` and regularised — the source mark is
/// deliberately hand-inked, and that texture reads as noise at terminal scale.
/// The SPAWN D trident, traced from the alpha channel of
/// `desktop/src-tauri/icons/tray@2x.png` and regularised — the source mark is
/// deliberately hand-inked, and that texture reads as noise at terminal scale.
/// The SPAWN D trident, traced from the alpha channel of
/// `desktop/src-tauri/icons/tray@2x.png` and regularised — the source mark is
/// deliberately hand-inked, and that texture reads as noise at terminal scale.
///
/// A terminal cell is roughly twice as tall as it is wide, so a mark drawn on
/// a square grid of characters comes out stretched vertically. The row count
/// is set against the column count with that 2:1 in mind, and the stem ends on
/// a half-block so it can stop mid-cell.
const UNICODE_LOGO: &str = r#" ██  ██  ██
 ██▄▄██▄▄██     S P A W N  D
 ██████████     ──────────────
     ██         your machine, possessed
     ▀▀"#;

const ASCII_LOGO: &str = r#" ||  ||  ||
 ||==||==||     S P A W N  D
 ##########     --------------
     ||         your machine, possessed
     ''"#;

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

    #[test]
    fn display_width_ignores_sgr_escapes() {
        let styled = format!("{}abc{:#}", panel_style(), panel_style());
        assert_eq!(display_width(&styled), 3);
        assert_eq!(display_width("plain"), 5);
        assert!(styled.len() > 3, "the escapes are really present");
    }

    #[test]
    fn panel_rows_are_all_the_same_visible_width() {
        let rows = vec![
            "short".to_owned(),
            format!("{}coloured and longer{:#}", panel_style(), panel_style()),
        ];
        let panel = render_panel("TITLE", &rows, 60, true);
        let widths: Vec<usize> = panel.iter().map(|line| display_width(line)).collect();
        assert!(
            widths.iter().all(|width| *width == 60),
            "ragged panel: {widths:?}"
        );
    }

    #[test]
    fn panel_survives_a_title_wider_than_the_frame() {
        let panel = render_panel(&"T".repeat(200), &[], 60, false);
        assert_eq!(panel.len(), 2, "no rows, so just the two borders");
    }

    /// The frame marched down the screen because one row was wider than the
    /// terminal: it wrapped onto a second physical line, the rewind counted
    /// logical lines, and every repaint landed a row low. These are the exact
    /// strings that did it — a long host name and a hint that would not fit.
    #[test]
    fn no_frame_row_can_ever_be_wider_than_the_frame() {
        for width in [MIN_FRAME_COLUMNS, 66, 72, 80, MAX_FRAME_COLUMNS] {
            let state = UiState {
                title: "POSSESSING Charlies-MacBook-Pro.local".to_owned(),
                steps: vec![
                    Step {
                        label: "Register this machine".to_owned(),
                        detail: "Charlies-MacBook-Pro.local".to_owned(),
                        state: StepState::Done,
                    },
                    Step {
                        label: "Approve in your browser".to_owned(),
                        detail: "[ WAITING FOR YOU ]".to_owned(),
                        state: StepState::Running,
                    },
                ],
                status: Some("waiting for approval — 5s · code expires in 30 min".to_owned()),
                hint: "ctrl-c to stop; nothing is registered".to_owned(),
                frame: 0,
                pending: Vec::new(),
                drawn: 0,
                width,
                finished: false,
            };
            for line in state.frame_lines() {
                assert!(
                    display_width(&line) <= width,
                    "row of {} columns in a {width}-column frame: {line:?}",
                    display_width(&line)
                );
            }
        }
    }

    #[test]
    fn the_hint_is_dropped_rather_than_run_into_the_status() {
        let long_status = "waiting for approval — 5s · code expires in 30 min";
        let state = UiState {
            title: "T".to_owned(),
            steps: Vec::new(),
            status: Some(long_status.to_owned()),
            hint: "ctrl-c to stop; nothing is registered".to_owned(),
            frame: 0,
            pending: Vec::new(),
            drawn: 0,
            width: 66,
            finished: false,
        };
        let status_row = state.frame_lines().pop().expect("a status row");
        assert!(status_row.contains("code expires in 30 min"));
        assert!(
            !status_row.contains("ctrl-c"),
            "the hint must be dropped, not jammed against the status: {status_row:?}"
        );

        // With room for both, the hint returns and there is a real gap.
        let roomy = UiState {
            width: MAX_FRAME_COLUMNS + 40,
            ..state
        };
        let row = roomy.frame_lines().pop().expect("a status row");
        assert!(row.contains("ctrl-c to stop"));
        assert!(
            row.contains("min    "),
            "at least MIN_HINT_GAP columns between"
        );
    }

    #[test]
    fn a_step_row_fills_the_width_with_leader_dots() {
        let row = render_step(
            StepState::Running,
            2,
            "Approve in browser",
            "[ WAIT ]",
            60,
            false,
        );
        assert_eq!(display_width(&row), 60);
        assert!(row.contains("2. Approve in browser"));
        assert!(row.contains("[ WAIT ]"));
    }

    #[test]
    fn a_step_row_never_underflows_on_a_narrow_frame() {
        let row = render_step(StepState::Done, 1, &"L".repeat(80), "[ DONE ]", 20, false);
        assert!(display_width(&row) >= 20, "must not panic or truncate away");
    }

    #[test]
    fn plain_mode_ui_is_inert_and_prints_the_historical_prefix() {
        // No tty under `cargo test`, so this is the plain path by construction.
        let ui = Ui::start("POSSESSING", &["one", "two"], "hint");
        assert!(!ui.is_rich());
        ui.begin(0, "[ RUNNING ]");
        ui.complete(0, "[ DONE ]");
        ui.status("waiting");
        ui.finish();
    }

    #[test]
    fn wrapping_splits_only_when_it_must_and_loses_nothing() {
        assert_eq!(wrap_plain("short", 20), vec!["short".to_owned()]);
        let long = "x".repeat(45);
        let wrapped = wrap_plain(&long, 20);
        assert_eq!(wrapped.len(), 3);
        assert_eq!(wrapped.concat(), long, "wrapping must not drop characters");
        assert!(wrapped.iter().all(|line| display_width(line) <= 20));
    }

    /// Not a check — a way to look at the live region without running a whole
    /// ceremony against a real server. Needs a tty, so run it under a pty:
    ///
    /// ```text
    /// script -q /dev/null cargo test --bin spawnd render_demo -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "visual; needs a tty"]
    fn render_demo() {
        print_logo();
        let ui = Ui::start(
            "POSSESSING Charlies-MacBook-Pro",
            &[
                "Register this machine",
                "Approve in your browser",
                "Store credentials",
                "Start background daemon",
            ],
            "ctrl-c to stop; nothing is registered",
        );
        ui.begin(0, "[ RUNNING ]");
        thread::sleep(Duration::from_millis(600));
        ui.complete(0, "Charlies-MacBook-Pro");
        ui.begin(1, "[ WAITING FOR YOU ]");
        ui.block(
            render_panel(
                "APPROVE THIS HOST",
                &[
                    String::new(),
                    dim("open this link on any device:", true),
                    bold(
                        "http://localhost:3000/device?ref=dGfl0YzRgEM6YrY9JVVDVPaIRWu8",
                        true,
                    ),
                    String::new(),
                    bold("press Enter to open it here", true),
                ],
                terminal_width(),
                true,
            ),
            &[],
        );
        for elapsed in 0..24 {
            ui.status(&format!(
                "waiting for approval — {elapsed}s · link expires in 29 min"
            ));
            if elapsed == 12 {
                ui.log("opened your browser to approve this host.");
            }
            thread::sleep(Duration::from_millis(100));
        }
        ui.complete(1, "approved");
        ui.complete(2, "host 9f1c2d3e");
        ui.begin(3, "[ RUNNING ]");
        thread::sleep(Duration::from_millis(700));
        ui.complete(3, "running");
        ui.finish();
        log_line("possessed as 9f1c2d3e. daemon running in the background.");
    }

    #[test]
    fn a_choice_row_never_outgrows_its_frame() {
        // A self-hosted origin is operator-supplied and can be any length.
        for label in [
            "spawnd.dev",
            "localhost:3000",
            "spawn.a-very-long-internal-hostname.example.test:8443",
        ] {
            for width in [40usize, 60, 72, 92] {
                let row =
                    render_choice_row(true, 1, label, "where this command came from", width, false);
                assert!(
                    display_width(&row) <= width,
                    "row {} wide in a {width} frame: {row:?}",
                    display_width(&row)
                );
            }
        }
    }

    #[test]
    fn word_wrapping_respects_the_width_and_breaks_an_oversized_word() {
        let wrapped = wrap_words("the link carries this key; your browser checks it", 20);
        assert!(
            wrapped.iter().all(|line| display_width(line) <= 20),
            "{wrapped:?}"
        );
        assert_eq!(
            wrapped.join(" "),
            "the link carries this key; your browser checks it"
        );

        // A word with no break opportunity must still be forced apart.
        let long = "x".repeat(50);
        let forced = wrap_words(&format!("see {long} now"), 20);
        assert!(
            forced.iter().all(|line| display_width(line) <= 20),
            "{forced:?}"
        );
        assert!(forced.concat().contains(&long));
    }

    #[test]
    fn terminal_width_caps_a_wide_terminal_without_inflating_a_narrow_one() {
        let width = terminal_width();
        assert!(
            (20..=MAX_FRAME_COLUMNS).contains(&width),
            "width {width} out of band"
        );
        // A narrow terminal must report its real width, not a padded one, or
        // every frame line wraps and the rewind math drifts.
        assert!(
            MIN_FRAME_COLUMNS > 20,
            "the stand-down threshold must bite first"
        );
    }

    #[test]
    fn a_pick_row_marks_focus_on_the_label_not_just_the_marker() {
        let width = 60;
        let chosen = render_choice_row(true, 1, "spawnd.dev", "the hosted service", width, true);
        let other = render_choice_row(false, 2, "Host yourself", "a server you run", width, true);

        assert_eq!(display_width(&chosen), width);
        assert_eq!(display_width(&other), width);

        // The unselected row recedes entirely: its label carries the same dim
        // colour as its detail, so nothing on it competes with the choice.
        let grey = format!(
            "{}",
            Style::new().fg_color(Some(AnsiColor::BrightBlack.into()))
        );
        assert!(
            other.contains(&format!("{grey}2. Host yourself")),
            "the unselected label must be grey: {other:?}"
        );
        assert!(
            !chosen.contains(&format!("{grey}1. spawnd.dev")),
            "the selected label must not be grey: {chosen:?}"
        );
        assert!(
            chosen.contains(glyphs().running),
            "the marker is still there"
        );
    }

    #[test]
    fn a_pick_row_is_plain_text_when_styling_is_off() {
        let row = render_choice_row(true, 1, "spawnd.dev", "hosted", 60, false);
        assert!(!row.contains('\u{1b}'), "no escapes in plain mode: {row:?}");
        assert_eq!(display_width(&row), 60);
    }

    #[test]
    fn a_hyperlink_is_invisible_to_the_width_maths() {
        // The OSC payload is a URL. Scanned as a CSI it would end at the "h" of
        // "http" and the rest would be counted as visible, tearing the frame.
        let url = "http://localhost:3000/device?ref=abcdef#k=ghijkl";
        let linked = hyperlink(url, "click me", true);
        assert_eq!(display_width(&linked), "click me".chars().count());
        assert!(linked.contains(url), "the target survives");
        assert_eq!(hyperlink(url, "click me", false), "click me");
    }

    #[test]
    fn a_panel_row_holding_a_hyperlink_still_squares_up() {
        let url = "http://localhost:3000/device?ref=dIF2cG14Xj3maek4#k=WsMbPmvzNwEnoPV1I";
        let rows = vec![hyperlink(url, &bold(url, true), true)];
        // Deliberately wider than the row so only the frame maths is exercised.
        let panel = render_panel("APPROVE THIS HOST", &rows, 120, true);
        let widths: Vec<usize> = panel.iter().map(|line| display_width(line)).collect();
        assert!(widths.iter().all(|w| *w == 120), "ragged: {widths:?}");
    }

    #[test]
    fn truncation_keeps_a_hyperlink_sequence_whole() {
        let url = "http://example.test/a";
        let linked = hyperlink(url, "abcdefghij", true);
        let cut = truncate_visible(&linked, 4);
        assert_eq!(display_width(&cut), 4);
        assert!(cut.contains(url), "the OSC target must not be sliced apart");
    }

    #[test]
    fn a_step_row_fits_inside_the_narrowest_frame_the_live_region_accepts() {
        let row = render_step(
            StepState::Running,
            4,
            "Start background daemon",
            "[ WAITING FOR YOU ]",
            MIN_FRAME_COLUMNS - 4,
            false,
        );
        assert_eq!(
            display_width(&row),
            MIN_FRAME_COLUMNS - 4,
            "a row must never exceed the frame it sits in"
        );
    }
}
