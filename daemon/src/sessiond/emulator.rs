//! Headless screen emulator: screen serialization and history line commits.
//!
//! The worker feeds every PTY output byte through this emulator so that, at
//! any moment, it can serialize the *current screen state* as an ANSI byte
//! stream that reconstructs it in the browser's xterm.js — replays open with
//! an exact synthesized repaint, and the session process is never signaled to
//! provoke one.
//!
//! The emulator is also the single authority on *scrollback history*: raw TUI
//! bytes are a rendering protocol, not a document, so history is recorded as
//! **committed lines** — a line is committed exactly once, at the moment it
//! scrolls off the top of the screen, serialized as styled text
//! ([`HistoryEvent::Lines`]). Intermediate repaint frames never commit
//! (rewrites happen in place), a resize cannot retroactively reflow what was
//! already committed, and an app erasing its scrollback (`CSI 3 J`) surfaces
//! as [`HistoryEvent::Truncate`] so the retained log is physically dropped.
//! alacritty's grid provides the commit semantics: primary-screen scrolls
//! rotate lines into grid history (`ED 2` scrolls the viewport into history,
//! VTE/kitty-style; regions anchored at the top row commit too), which
//! `feed_output` drains after every span and clears, keeping the grid's
//! resident history transiently small.
//!
//! This means the worker deliberately retains plaintext semantic state for
//! the current primary and alternate screen for its lifetime. The state is
//! bounded by the active terminal geometry plus the bounded drain window; it
//! is not a second user-facing renderer and it never rewrites the live byte
//! path. Serialized checkpoints and drained lines are transient plaintext and
//! are encrypted before being written to the scrollback segment files.
//!
//! Fidelity contract (enforced by the unit tests and, eventually, the
//! term-conformance corpus): `feed(bytes)` then `serialize()` then feeding the
//! serialized stream into a fresh emulator yields an identical screen — cells,
//! attributes, cursor, modes, margins, charsets.
//!
//! Design note: alacritty's `Term` keeps the scroll region, the active
//! charset index (the SI/SO shift state) and tab stops private, and its
//! DECSC register has no room for the shift at all. Rather than a fragile
//! delegation wrapper around its ~90 `Handler` methods, a second `Processor`
//! drives a tiny shadow handler that records only those states — the shift,
//! and the shift each screen's register was saved under (every other
//! callback is a vte-provided no-op). Both parsers consume the same bytes,
//! so their views cannot drift. The G0–G3 designations are read from the
//! grid cursor, where alacritty keeps them per screen and saves and restores
//! them with DECSC/DECRC, exactly as xterm does.
//!
//! Every glyph the emulator paints is already mapped through the app's
//! character sets, so a checkpoint and the worker's replay head first return
//! the consumer to ASCII (`ESC ( B ESC ) B ESC * B ESC + B SI`,
//! [`RETURN_TO_ASCII`]) and the checkpoint's tail re-arms the app's
//! designations and shift state at the end. Without the return, a consumer
//! the app left mid line-drawing mapped the painted glyphs a second time
//! (#61).
//!
//! Known v1 limitations, all self-healing on the app's next full repaint:
//! custom tab stops are not serialized (would need cursor tracking in the
//! shadow); the emulator's own DECRC restores designations but not the shift
//! (alacritty's register), where xterm.js's restores the table that was
//! active at DECSC — the two consumers differ natively when an app shifts
//! between ESC 7 and ESC 8, so a checkpoint taken between the two rebuilds
//! the register such that each consumer restores what it natively would,
//! and one taken after the ESC 8 carries the emulator's outcome to both; an
//! inactive alternate screen's register is not carried, so a consumer
//! re-entering it and restoring without saving there first restores ASCII
//! at home; xterm.js keeps one set of designations across `?1049l` where
//! alacritty keeps one per screen, so an alternate-screen DECRC that was
//! never paired with a DECSC there leaves an xterm.js consumer with the
//! default register's ASCII sets after the app leaves; and G2/G3 are
//! designated but never made active, since vte delivers no LS2/LS3 to the
//! emulator (xterm.js does implement them, a native divergence).

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Charsets, Cursor, Dimensions};
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{
    CharsetIndex, Color, CursorShape, Handler, NamedColor, NamedPrivateMode, PrivateMode,
    Processor, StandardCharset,
};

#[derive(Clone)]
struct Sink;

impl EventListener for Sink {
    fn send_event(&self, _event: Event) {}
}

/// Upper bound on grid-resident history between drains. PTY reads are 8 KiB,
/// so one drain window can commit at most ~8k lines (one LF per byte); the
/// margin covers a same-window `ED 2` viewport push on a tall screen.
const HISTORY_DRAIN_CAP: usize = 10_000;
/// Drain stride within one `feed_output` call: bounds both the resident
/// history ring and the size of any single committed-lines batch.
const FEED_DRAIN_STRIDE: usize = 2 * 1024;

/// `ESC ( B ESC ) B ESC * B ESC + B SI`: designate ASCII to G0–G3 and shift
/// in. Every glyph the emulator paints — the screen chunk and the committed
/// lines alike — is already mapped, so a consumer the app left in a
/// line-drawing set would map it a second time. Opens the checkpoint baseline
/// and the worker's replay head; the clients' reseed clear leads with the G0,
/// G1 and SI part of it. G2/G3 are returned too so that the emulator's own
/// mirror of the baseline leaves every slot where the tail expects it.
pub const RETURN_TO_ASCII: &[u8] = b"\x1b(B\x1b)B\x1b*B\x1b+B\x0f";

/// Painting baseline: default pen, ASCII character sets, no margins,
/// absolute addressing, autowrap on (paint_screen relies on natural
/// wrapping), cursor hidden while it moves. There is deliberately no ED (2J):
/// paint_screen covers every row (content or EL), which makes the state
/// stream idempotent when written over an already-populated terminal — it
/// can never scroll stale content into scrollback, so checkpoints may appear
/// mid-stream. There is also deliberately no `?1049l`/alt normalization
/// prefix: the client detects "is an alt app active" from these bytes, and a
/// spurious 1049 toggle in every checkpoint poisons that detection. The
/// charset return is [`RETURN_TO_ASCII`] byte for byte (a test pins it).
const BASELINE: &[u8] = b"\x1b[0m\x1b(B\x1b)B\x1b*B\x1b+B\x0f\x1b[r\x1b[?6l\x1b[?7h\x1b[?25l";

/// History effects observed while feeding PTY output, in stream order.
pub enum HistoryEvent {
    /// Lines that scrolled off the screen, serialized as a self-contained
    /// styled text stream: SGR runs + glyphs, `\r\n` after each hard line
    /// end; soft-wrapped rows are painted edge-to-edge with no break so the
    /// logical line re-wraps naturally at the consumer's width. The glyphs
    /// are already mapped through the app's character sets, so a terminal in
    /// a line-drawing set would map them again: the replay head returns the
    /// consumer to ASCII before the history section, and a consumer that
    /// appends live deltas into a terminal the app is drawing on must do
    /// the same ([`RETURN_TO_ASCII`]) and re-arm the app's sets after.
    Lines(Vec<u8>),
    /// The app erased its scrollback (`CSI 3 J` / `CSI ? 3 J`): previously
    /// committed lines must be dropped.
    Truncate,
}

/// Cross-chunk matcher for `ESC [ 3 J` and `ESC [ ? 3 J`. Byte-exact rather
/// than a full CSI parser: these are the only forms terminals emit for a
/// scrollback wipe, and a payload collision inside an opaque string would
/// merely truncate history the app had asked to be unreadable anyway.
#[derive(Default)]
struct WipeScanner {
    state: WipeState,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum WipeState {
    #[default]
    Ground,
    Escape,
    Csi,
    CsiQuestion,
    CsiThree,
}

impl WipeScanner {
    /// Advance through `bytes`; true when a wipe sequence completed inside.
    fn scan(&mut self, bytes: &[u8]) -> bool {
        let mut matched = false;
        for &byte in bytes {
            self.state = match (self.state, byte) {
                (_, 0x1b) => WipeState::Escape,
                (WipeState::Escape, b'[') => WipeState::Csi,
                (WipeState::Csi, b'?') => WipeState::CsiQuestion,
                (WipeState::Csi | WipeState::CsiQuestion, b'3') => WipeState::CsiThree,
                (WipeState::CsiThree, b'J') => {
                    matched = true;
                    WipeState::Ground
                }
                _ => WipeState::Ground,
            };
        }
        matched
    }
}

/// States alacritty tracks but does not expose; recorded from a second parse
/// of the same byte stream.
#[derive(Clone, Debug, PartialEq)]
struct Shadow {
    /// 1-based (top, bottom) margins when narrower than the full screen.
    margins: Option<(u16, u16)>,
    /// The shift state: which of G0–G3 the app's bytes currently map through.
    active_charset: CharsetIndex,
    /// The shift each screen's DECSC register was saved under
    /// (`[primary, alternate]`). alacritty's register keeps designations and
    /// no shift; xterm.js's keeps the one table the shift selected. A
    /// checkpoint rebuilds each register under the shift it was saved under,
    /// so a consumer of either kind restores what its own DECSC would have.
    saved_shift: [CharsetIndex; 2],
    /// Which screen the next DECSC fills.
    alt: bool,
    rows: u16,
}

impl Shadow {
    fn new(rows: u16) -> Self {
        Self {
            margins: None,
            active_charset: CharsetIndex::G0,
            saved_shift: [CharsetIndex::G0; 2],
            alt: false,
            rows,
        }
    }

    fn resize(&mut self, rows: u16) {
        self.rows = rows;
        // Terminals reset margins on resize; alacritty does the same.
        self.margins = None;
    }
}

impl Handler for Shadow {
    fn set_scrolling_region(&mut self, top: usize, bottom: Option<usize>) {
        let rows = self.rows as usize;
        let top = top.max(1);
        let bottom = bottom.unwrap_or(rows).min(rows);
        if bottom <= top {
            return; // invalid; terminals ignore
        }
        self.margins = if top == 1 && bottom == rows {
            None
        } else {
            Some((top as u16, bottom as u16))
        };
    }

    fn set_active_charset(&mut self, index: CharsetIndex) {
        self.active_charset = index;
    }

    /// `ESC 7` and `CSI s`, on whichever screen is active.
    fn save_cursor_position(&mut self) {
        self.saved_shift[usize::from(self.alt)] = self.active_charset;
    }

    fn set_private_mode(&mut self, mode: PrivateMode) {
        // Entering the alternate screen saves the primary cursor: alacritty
        // overwrites the primary register with it, and xterm's `?1049h` is a
        // DECSC. The primary register's shift is the shift at entry.
        if mode == PrivateMode::Named(NamedPrivateMode::SwapScreenAndSetRestoreCursor) && !self.alt
        {
            self.saved_shift[0] = self.active_charset;
            self.alt = true;
        }
    }

    fn unset_private_mode(&mut self, mode: PrivateMode) {
        if mode == PrivateMode::Named(NamedPrivateMode::SwapScreenAndSetRestoreCursor) {
            self.alt = false;
        }
    }

    fn reset_state(&mut self) {
        *self = Shadow::new(self.rows);
    }
}

pub struct Emulator {
    term: Term<Sink>,
    parser: Processor,
    shadow: Shadow,
    shadow_parser: Processor,
    wipe_scanner: WipeScanner,
    cols: u16,
    rows: u16,
}

impl Emulator {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let config = Config {
            // Grid history is a transient drain window, not the deep store:
            // `feed_output` commits and clears it every stride. Deep history
            // lives in the encrypted line log.
            scrolling_history: HISTORY_DRAIN_CAP,
            ..Config::default()
        };
        let size = TermSize::new(cols as usize, rows as usize);
        Self {
            term: Term::new(config, &size, Sink),
            parser: Processor::new(),
            shadow: Shadow::new(rows),
            shadow_parser: Processor::new(),
            wipe_scanner: WipeScanner::default(),
            cols,
            rows,
        }
    }

    /// Raw feed: parses without draining history. Used by `serialize`'s
    /// self-repair (whose streams never scroll) and by tests that only care
    /// about screen state.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.shadow_parser.advance(&mut self.shadow, bytes);
    }

    /// Feed PTY output, returning the history effects it produced in stream
    /// order. Strided so the grid-resident history stays bounded regardless
    /// of chunk size; a scrollback wipe inside a stride orders its
    /// `Truncate` before that stride's surviving commits (lines the wipe
    /// already removed from the grid were doomed regardless).
    pub fn feed_output(&mut self, bytes: &[u8]) -> Vec<HistoryEvent> {
        let mut events = Vec::new();
        for stride in bytes.chunks(FEED_DRAIN_STRIDE) {
            let wiped = self.wipe_scanner.scan(stride);
            self.feed(stride);
            if wiped {
                events.push(HistoryEvent::Truncate);
            }
            if let Some(lines) = self.drain_history() {
                events.push(HistoryEvent::Lines(lines));
            }
        }
        events
    }

    /// Serialize and clear every line the grid has rotated into history.
    fn drain_history(&mut self) -> Option<Vec<u8>> {
        let count = self.term.grid().history_size();
        if count == 0 {
            return None;
        }
        // Drop frame-padding blank runs without eating authored blank lines.
        // Two things scroll a band of empty rows into history: a full-screen
        // clear (ED 2) on SIGWINCH, and a sparse TUI screen (content low, blank
        // above) whose blank rows scroll off as output flows. Either way a
        // blank RUN at least half a screenful tall is padding, never authored,
        // and would show as a scrollback "blank band" (including one wedged at
        // the history↔live-screen seam). A blank line between two paragraphs is
        // real output — often just one or two rows, frequently landing at a
        // batch edge while streaming — so short runs are kept. Any maximal
        // blank run ≥ band_min is dropped wherever it sits (leading, interior,
        // or trailing); shorter runs are painted verbatim. A blank row is never
        // a soft-wrap continuation, so re-wrapping is unaffected.
        let band_min = (self.rows as usize / 2).max(4);
        let grid = self.term.grid();
        let offsets: Vec<usize> = (1..=count).rev().collect(); // oldest → newest
        let is_blank = |offset: usize| is_blank_history_row(&grid[Line(-(offset as i32))]);
        let n = offsets.len();

        let mut out = Vec::with_capacity(n * 48);
        // Each batch is self-contained: an evicted or truncated predecessor
        // batch must not leak pen or hyperlink state into this one.
        out.extend_from_slice(b"\x1b[0m");
        let mut pen = Pen::default();
        let mut hyperlink: Option<alacritty_terminal::term::cell::Hyperlink> = None;
        let mut emitted_content = false;
        let mut i = 0;
        while i < n {
            if is_blank(offsets[i]) {
                let mut j = i;
                while j < n && is_blank(offsets[j]) {
                    j += 1;
                }
                if j - i < band_min {
                    for &offset in &offsets[i..j] {
                        paint_history_row(
                            &grid[Line(-(offset as i32))],
                            &mut pen,
                            &mut hyperlink,
                            &mut out,
                        );
                    }
                }
                i = j;
            } else {
                paint_history_row(
                    &grid[Line(-(offsets[i] as i32))],
                    &mut pen,
                    &mut hyperlink,
                    &mut out,
                );
                emitted_content = true;
                i += 1;
            }
        }
        // A batch with no surviving content is pure clear/repaint padding —
        // commit nothing (matches the previous drop-all-blank behaviour).
        if !emitted_content {
            return None;
        }
        set_hyperlink(&mut out, &mut hyperlink, None);
        out.extend_from_slice(b"\x1b[0m");
        self.term.grid_mut().clear_history();
        Some(out)
    }

    /// Resize the screen. Narrowing reflows wrapped screen rows and can push
    /// the excess into grid history — those rows genuinely left the screen,
    /// so they are committed (kitty/VTE resize semantics). The grid history
    /// is empty on entry (drained every feed), so widening has nothing to
    /// pull back and can never un-commit a line.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<HistoryEvent> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.cols = cols;
        self.rows = rows;
        self.term
            .resize(TermSize::new(cols as usize, rows as usize));
        self.shadow.resize(rows);
        match self.drain_history() {
            Some(lines) => vec![HistoryEvent::Lines(lines)],
            None => Vec::new(),
        }
    }

    pub fn geometry(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    /// Screen contents as trimmed text rows (tests and diagnostics).
    pub fn screen_text(&self) -> Vec<String> {
        let grid = self.term.grid();
        (0..self.rows as i32)
            .map(|row| {
                (0..self.cols as usize)
                    .map(|col| grid[Line(row)][Column(col)].c)
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    /// Serialize the full terminal state as an ANSI stream that reconstructs
    /// it in a fresh (or reset) terminal of the same geometry.
    ///
    /// Alt-screen note: alacritty's `swap_alt()` wipes the alt grid whenever
    /// it swaps *away from* the primary screen, so painting the primary while
    /// the alt screen is active destroys our own alt state. The reconstruction
    /// tail (alt repaint + cursor + pen + modes) is therefore fed back into
    /// this emulator, repairing it with the exact bytes the consumer gets —
    /// the fidelity contract makes that repair lossless, and
    /// `serialize_is_stable` verifies it.
    pub fn serialize(&mut self) -> Vec<u8> {
        // Everything the swaps below can disturb is captured up front. The
        // character sets in particular: the baseline mirrored into self on the
        // alt path returns them to ASCII, and the tail must re-arm the app's.
        let mode = *self.term.mode();
        let margins = self.shadow.margins;
        let charsets = self.term.grid().cursor.charsets;
        let active_charset = self.shadow.active_charset;
        let saved_shift = self.shadow.saved_shift;
        let cursor = self.term.grid().cursor.point;
        let needs_wrap = self.term.grid().cursor.input_needs_wrap;
        let wrap_cell = self.term.grid()[cursor.line][cursor.column].clone();
        let template = self.term.grid().cursor.template.clone();
        // The DECSC register: Ink-style renderers (claude, codex) wrap every
        // frame in save/restore, so a checkpoint landing mid-frame MUST
        // reproduce it or the replayed DECRC teleports the next frame.
        let saved = self.term.grid().saved_cursor.clone();
        let mut active_paint = Vec::with_capacity(4096);
        paint_screen(&self.term, &mut active_paint);

        let mut out: Vec<u8> = Vec::with_capacity(8192);
        out.extend_from_slice(BASELINE);

        let alt_active = mode.contains(TermMode::ALT_SCREEN);
        if alt_active {
            // Paint the primary screen first so leaving the alt screen after
            // reattach reveals the right content. The primary grid is the
            // source of that paint, not its target: nothing here is fed back.
            self.term.swap_alt();
            paint_screen(&self.term, &mut out);
            // Primary's DECSC register: its saved cursor is clobbered in
            // self by the swap below, and a consumer's `?1049h` saves the
            // cursor again anyway, so what this carries is the primary pen;
            // the shift it is rebuilt under is moot for the same reason.
            emit_saved_cursor(&mut out, &self.term.grid().saved_cursor, saved_shift[0]);
            emit_cup(&mut out, cursor_point(&self.term));
            // The primary's own character sets and shift, as they were when
            // the app entered the alternate screen: alacritty keeps the sets
            // on the primary grid across the swap, and xterm.js saves the
            // table the shift selects at `?1049h`, so either restores them
            // when the app leaves. The return after `?1049h` shifts in again.
            emit_designations(&mut out, &self.term.grid().cursor.charsets, b'0');
            if saved_shift[0] == CharsetIndex::G1 {
                out.push(0x0e); // SO
            }
            self.term.swap_alt(); // wipes the alt grid; the tail repairs it

            // Mirror the baseline in self now that the alt grid is the target
            // again. Swapping back copies the primary cursor — pen, character
            // sets, pending wrap — over the alt grid's, so a reset applied
            // before the swaps would not survive them, and the tail, which
            // only re-arms what differs from the baseline, would leave the
            // primary's sets behind in self.
            self.feed(BASELINE);
            out.extend_from_slice(b"\x1b[?1049h");
            // The alt screen's paint runs in ASCII like the primary's did.
            out.extend_from_slice(RETURN_TO_ASCII);
        }

        // Reconstruction tail: active screen and every remaining state. Built
        // separately so the alt path can replay it into self.
        let mut tail: Vec<u8> = Vec::with_capacity(4096);
        tail.extend_from_slice(&active_paint);

        // Margins (CSI r homes the cursor; emitted before final placement).
        if let Some((top, bottom)) = margins {
            tail.extend_from_slice(format!("\x1b[{top};{bottom}r").as_bytes());
        }
        // Re-arm the DECSC register before origin mode and final placement
        // (absolute CUP + ESC 7, then the real cursor state below).
        emit_saved_cursor(&mut tail, &saved, saved_shift[usize::from(alt_active)]);
        if mode.contains(TermMode::ORIGIN) {
            tail.extend_from_slice(b"\x1b[?6h");
        }

        // Cursor placement. Under origin mode CUP is margin-relative.
        let mut point = cursor;
        if mode.contains(TermMode::ORIGIN) {
            let top = margins.map_or(1, |(t, _)| t) as i32;
            point.line = Line((point.line.0 - (top - 1)).max(0));
        }
        emit_cup(&mut tail, point);

        // Re-arm the pending-wrap flag: rewrite the cell under the cursor at
        // the final column so the next app byte wraps exactly as it would
        // have live.
        if needs_wrap {
            let mut pen = Pen::default();
            pen.apply_cell(&mut tail, &wrap_cell);
            let mut buf = [0u8; 4];
            tail.extend_from_slice(wrap_cell.c.encode_utf8(&mut buf).as_bytes());
        }

        // The app's current pen, so its next output keeps its attributes.
        let mut pen = Pen::default();
        pen.apply_cell(&mut tail, &template);

        self.finish_tail(out, tail, mode, alt_active, charsets, active_charset)
    }

    fn finish_tail(
        &mut self,
        mut out: Vec<u8>,
        mut tail: Vec<u8>,
        mode: TermMode,
        alt_active: bool,
        charsets: Charsets,
        active_charset: CharsetIndex,
    ) -> Vec<u8> {
        self.append_modes(&mut tail, mode, charsets, active_charset);
        out.extend_from_slice(&tail);
        if alt_active {
            self.feed(&tail);
        }
        out
    }

    fn append_modes(
        &mut self,
        out: &mut Vec<u8>,
        mode: TermMode,
        charsets: Charsets,
        active_charset: CharsetIndex,
    ) {
        // Modes.
        if !mode.contains(TermMode::LINE_WRAP) {
            out.extend_from_slice(b"\x1b[?7l");
        }
        if mode.contains(TermMode::APP_CURSOR) {
            out.extend_from_slice(b"\x1b[?1h");
        }
        if mode.contains(TermMode::APP_KEYPAD) {
            out.extend_from_slice(b"\x1b=");
        }
        if mode.contains(TermMode::INSERT) {
            out.extend_from_slice(b"\x1b[4h");
        }
        if mode.contains(TermMode::LINE_FEED_NEW_LINE) {
            out.extend_from_slice(b"\x1b[20h");
        }
        if mode.contains(TermMode::MOUSE_REPORT_CLICK) {
            out.extend_from_slice(b"\x1b[?1000h");
        }
        if mode.contains(TermMode::MOUSE_DRAG) {
            out.extend_from_slice(b"\x1b[?1002h");
        }
        if mode.contains(TermMode::MOUSE_MOTION) {
            out.extend_from_slice(b"\x1b[?1003h");
        }
        if mode.contains(TermMode::UTF8_MOUSE) {
            out.extend_from_slice(b"\x1b[?1005h");
        }
        if mode.contains(TermMode::SGR_MOUSE) {
            out.extend_from_slice(b"\x1b[?1006h");
        }
        if mode.contains(TermMode::FOCUS_IN_OUT) {
            out.extend_from_slice(b"\x1b[?1004h");
        }
        if mode.contains(TermMode::BRACKETED_PASTE) {
            out.extend_from_slice(b"\x1b[?2004h");
        }

        // Charset designations and the shift state, as the app left them and
        // as captured before the baseline. Grid cells store already-mapped
        // glyphs, so the paint above ran in ASCII; only now, with nothing
        // left to paint, are the app's sets re-armed, so its next bytes map
        // in the consumer exactly as they do here.
        emit_designations(out, &charsets, b'0');
        match active_charset {
            CharsetIndex::G0 => {}
            CharsetIndex::G1 => out.push(0x0e), // SO
            // Unreachable: vte 0.15 delivers no LS2/LS3, so the shift is
            // only ever G0 or G1.
            _ => {}
        }

        // Cursor style.
        let style = self.term.cursor_style();
        let decscusr = match (style.shape, style.blinking) {
            (CursorShape::Underline, true) => 3,
            (CursorShape::Underline, false) => 4,
            (CursorShape::Beam, true) => 5,
            (CursorShape::Beam, false) => 6,
            (_, true) => 1,
            (_, false) => 2,
        };
        out.extend_from_slice(format!("\x1b[{decscusr} q").as_bytes());

        // Palette overrides.
        for i in 0..=255usize {
            if let Some(rgb) = self.term.colors()[i] {
                out.extend_from_slice(
                    format!(
                        "\x1b]4;{i};rgb:{:02x}/{:02x}/{:02x}\x1b\\",
                        rgb.r, rgb.g, rgb.b
                    )
                    .as_bytes(),
                );
            }
        }
        for (idx, osc) in [
            (NamedColor::Foreground as usize, 10),
            (NamedColor::Background as usize, 11),
            (NamedColor::Cursor as usize, 12),
        ] {
            if let Some(rgb) = self.term.colors()[idx] {
                out.extend_from_slice(
                    format!(
                        "\x1b]{osc};rgb:{:02x}/{:02x}/{:02x}\x1b\\",
                        rgb.r, rgb.g, rgb.b
                    )
                    .as_bytes(),
                );
            }
        }

        // Cursor visibility last, once everything stopped moving it.
        if mode.contains(TermMode::SHOW_CURSOR) {
            out.extend_from_slice(b"\x1b[?25h");
        }
    }
}

fn cursor_point<T>(term: &Term<T>) -> Point {
    term.grid().cursor.point
}

/// Reconstruct a DECSC register: designate the saved character sets, shift
/// as the app had at its ESC 7, position with the saved pen, save, then
/// shift in and return those sets to ASCII — the register keeps them while
/// the terminal stays where the baseline put it. alacritty's register holds
/// the designations and DECRC restores them; xterm.js's holds the table that
/// was active at ESC 7 and DECRC reinstates it, so the shift matters there:
/// an app that framed `ESC ) 0 SO … ESC 7` (the tmux/screen `smacs`) gets
/// line drawing back from its ESC 8 on either consumer, and one that saved
/// under SI with G0 line drawing and shifted out since is not misread. The
/// pen is left for the caller to overwrite (every later emission resets it).
fn emit_saved_cursor(out: &mut Vec<u8>, saved: &Cursor<Cell>, shift: CharsetIndex) {
    emit_designations(out, &saved.charsets, b'0');
    if shift == CharsetIndex::G1 {
        out.push(0x0e); // SO
    }
    let mut pen = Pen::default();
    pen.apply_cell(out, &saved.template);
    emit_cup(out, saved.point);
    out.extend_from_slice(b"\x1b7");
    if shift == CharsetIndex::G1 {
        out.push(0x0f); // SI
    }
    emit_designations(out, &saved.charsets, b'B');
}

/// Designate `final_byte` (`0` line drawing, `B` ASCII) to every slot of
/// `charsets` that is not ASCII. Relative to a terminal at the baseline, `0`
/// arms exactly the app's sets and `B` returns exactly those.
fn emit_designations(out: &mut Vec<u8>, charsets: &Charsets, final_byte: u8) {
    const SLOTS: [(CharsetIndex, u8); 4] = [
        (CharsetIndex::G0, b'('),
        (CharsetIndex::G1, b')'),
        (CharsetIndex::G2, b'*'),
        (CharsetIndex::G3, b'+'),
    ];
    for (index, designator) in SLOTS {
        if charsets[index] != StandardCharset::Ascii {
            out.extend_from_slice(&[0x1b, designator, final_byte]);
        }
    }
}

fn emit_cup(out: &mut Vec<u8>, point: Point) {
    let row = point.line.0 + 1;
    let col = point.column.0 + 1;
    out.extend_from_slice(format!("\x1b[{row};{col}H").as_bytes());
}

/// Attribute flags that translate to SGR (everything except layout flags).
const PEN_FLAGS: Flags = Flags::INVERSE
    .union(Flags::BOLD)
    .union(Flags::ITALIC)
    .union(Flags::UNDERLINE)
    .union(Flags::DIM)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT)
    .union(Flags::DOUBLE_UNDERLINE)
    .union(Flags::UNDERCURL)
    .union(Flags::DOTTED_UNDERLINE)
    .union(Flags::DASHED_UNDERLINE);

/// Tracks the last-emitted SGR state; re-emits on change. Changes always
/// reset and reapply in full — verbose but unambiguous.
#[derive(Default)]
struct Pen {
    state: Option<(Color, Color, Flags, Option<Color>)>,
}

impl Pen {
    fn apply_cell(&mut self, out: &mut Vec<u8>, cell: &Cell) {
        let flags = cell.flags & PEN_FLAGS;
        let key = (cell.fg, cell.bg, flags, cell.underline_color());
        if self.state == Some(key) {
            return;
        }
        self.state = Some(key);

        let mut codes: Vec<String> = vec!["0".into()];
        if flags.contains(Flags::BOLD) {
            codes.push("1".into());
        }
        if flags.contains(Flags::DIM) {
            codes.push("2".into());
        }
        if flags.contains(Flags::ITALIC) {
            codes.push("3".into());
        }
        if flags.contains(Flags::UNDERLINE) {
            codes.push("4".into());
        }
        if flags.contains(Flags::DOUBLE_UNDERLINE) {
            codes.push("4:2".into());
        }
        if flags.contains(Flags::UNDERCURL) {
            codes.push("4:3".into());
        }
        if flags.contains(Flags::DOTTED_UNDERLINE) {
            codes.push("4:4".into());
        }
        if flags.contains(Flags::DASHED_UNDERLINE) {
            codes.push("4:5".into());
        }
        if flags.contains(Flags::INVERSE) {
            codes.push("7".into());
        }
        if flags.contains(Flags::HIDDEN) {
            codes.push("8".into());
        }
        if flags.contains(Flags::STRIKEOUT) {
            codes.push("9".into());
        }
        push_color(&mut codes, cell.fg, ColorTarget::Fg);
        push_color(&mut codes, cell.bg, ColorTarget::Bg);
        if let Some(ul) = cell.underline_color() {
            push_color(&mut codes, ul, ColorTarget::Underline);
        }
        out.extend_from_slice(format!("\x1b[{}m", codes.join(";")).as_bytes());
    }
}

enum ColorTarget {
    Fg,
    Bg,
    Underline,
}

fn push_color(codes: &mut Vec<String>, color: Color, target: ColorTarget) {
    let (named_base, bright_base, extended, default_code) = match target {
        ColorTarget::Fg => (30, 90, 38, 39),
        ColorTarget::Bg => (40, 100, 48, 49),
        ColorTarget::Underline => (0, 0, 58, 59),
    };
    match color {
        Color::Named(name) => {
            let idx = name as usize;
            let code = match target {
                ColorTarget::Underline => default_code,
                _ if idx < 8 => named_base + idx,
                _ if (8..16).contains(&idx) => bright_base + (idx - 8),
                // Dim variants keep their base color; DIM is a flag.
                _ if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize)
                    .contains(&idx) =>
                {
                    named_base + (idx - NamedColor::DimBlack as usize)
                }
                _ => default_code,
            };
            if code != default_code || matches!(target, ColorTarget::Fg | ColorTarget::Bg) {
                codes.push(code.to_string());
            }
        }
        Color::Indexed(i) => codes.push(format!("{extended};5;{i}")),
        Color::Spec(rgb) => codes.push(format!("{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b)),
    }
}

fn paint_screen<T>(term: &Term<T>, out: &mut Vec<u8>) {
    let cols = term.columns();
    let rows = term.screen_lines();
    let grid = term.grid();
    let mut pen = Pen::default();
    let mut hyperlink: Option<alacritty_terminal::term::cell::Hyperlink> = None;

    out.extend_from_slice(b"\x1b[H");
    for row in 0..rows {
        let line = &grid[Line(row as i32)];
        let wrapped = line[Column(cols - 1)].flags.contains(Flags::WRAPLINE);

        // Trailing cells that are fully default render via EL, but a soft
        // wrapped row must be painted edge-to-edge to re-trigger the wrap.
        let mut end = cols;
        if !wrapped {
            while end > 0 && is_default_cell(&line[Column(end - 1)]) {
                end -= 1;
            }
        }

        for col in 0..end {
            let cell = &line[Column(col)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                // xterm recreates spacers when the wide char itself arrives.
                continue;
            }
            set_hyperlink(out, &mut hyperlink, cell.hyperlink());
            pen.apply_cell(out, cell);
            let mut buf = [0u8; 4];
            out.extend_from_slice(cell.c.encode_utf8(&mut buf).as_bytes());
            if let Some(zerowidth) = cell.zerowidth() {
                for zw in zerowidth {
                    out.extend_from_slice(zw.encode_utf8(&mut buf).as_bytes());
                }
            }
        }

        if !wrapped {
            if end < cols {
                set_hyperlink(out, &mut hyperlink, None);
                pen.apply_cell(out, &Cell::default());
                out.extend_from_slice(b"\x1b[K");
            }
            if row + 1 < rows {
                out.extend_from_slice(b"\r\n");
            }
        }
        // A wrapped row emits nothing: the next row's first glyph continues
        // the same logical line, reproducing the WRAPLINE flag naturally.
    }
    set_hyperlink(out, &mut hyperlink, None);
    out.extend_from_slice(b"\x1b[0m");
}

/// Paint one committed history row as flowing styled text. Hard-ended rows
/// are trimmed of trailing default cells and closed with `\r\n`; soft-wrapped
/// rows paint edge-to-edge and emit no break, so the logical line reassembles
/// and re-wraps naturally at whatever width the consumer renders at.
fn paint_history_row(
    line: &alacritty_terminal::grid::Row<Cell>,
    pen: &mut Pen,
    hyperlink: &mut Option<alacritty_terminal::term::cell::Hyperlink>,
    out: &mut Vec<u8>,
) {
    let cols = line.len();
    let wrapped = cols > 0 && line[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
    let mut end = cols;
    if !wrapped {
        while end > 0 && is_default_cell(&line[Column(end - 1)]) {
            end -= 1;
        }
    }
    for col in 0..end {
        let cell = &line[Column(col)];
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        set_hyperlink(out, hyperlink, cell.hyperlink());
        pen.apply_cell(out, cell);
        let mut buf = [0u8; 4];
        out.extend_from_slice(cell.c.encode_utf8(&mut buf).as_bytes());
        if let Some(zerowidth) = cell.zerowidth() {
            for zw in zerowidth {
                out.extend_from_slice(zw.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    if !wrapped {
        out.extend_from_slice(b"\r\n");
    }
}

/// A history row that carries no authored content: not a soft-wrap
/// continuation, and every cell default. Such rows at a batch's edges are
/// clear/repaint padding, not output, and are dropped before committing.
fn is_blank_history_row(line: &alacritty_terminal::grid::Row<Cell>) -> bool {
    let cols = line.len();
    if cols > 0 && line[Column(cols - 1)].flags.contains(Flags::WRAPLINE) {
        return false; // soft-wrap continuation; part of a logical line
    }
    (0..cols).all(|col| is_default_cell(&line[Column(col)]))
}

fn is_default_cell(cell: &Cell) -> bool {
    cell.c == ' '
        && cell.fg == Color::Named(NamedColor::Foreground)
        && cell.bg == Color::Named(NamedColor::Background)
        && (cell.flags & (PEN_FLAGS | Flags::WIDE_CHAR | Flags::WIDE_CHAR_SPACER)).is_empty()
        && cell.zerowidth().is_none()
        && cell.hyperlink().is_none()
}

fn set_hyperlink(
    out: &mut Vec<u8>,
    current: &mut Option<alacritty_terminal::term::cell::Hyperlink>,
    next: Option<alacritty_terminal::term::cell::Hyperlink>,
) {
    if *current == next {
        return;
    }
    match &next {
        Some(link) => {
            let id = link.id();
            let params = if id.is_empty() {
                String::new()
            } else {
                format!("id={id}")
            };
            out.extend_from_slice(format!("\x1b]8;{params};{}\x1b\\", link.uri()).as_bytes());
        }
        None => out.extend_from_slice(b"\x1b]8;;\x1b\\"),
    }
    *current = next;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(cols: u16, rows: u16, input: &[u8]) -> (Emulator, Emulator) {
        let mut a = Emulator::new(cols, rows);
        a.feed(input);
        let bytes = a.serialize();
        let mut b = Emulator::new(cols, rows);
        b.feed(&bytes);
        (a, b)
    }

    fn assert_same_state(a: &Emulator, b: &Emulator, context: &str) {
        let (ga, gb) = (a.term.grid(), b.term.grid());
        assert_eq!(a.rows, b.rows, "{context}: rows");
        assert_eq!(a.cols, b.cols, "{context}: cols");
        for row in 0..a.rows as i32 {
            for col in 0..a.cols as usize {
                let (ca, cb) = (&ga[Line(row)][Column(col)], &gb[Line(row)][Column(col)]);
                assert_eq!(
                    (ca.c, ca.fg, ca.bg, ca.flags, ca.underline_color()),
                    (cb.c, cb.fg, cb.bg, cb.flags, cb.underline_color()),
                    "{context}: cell ({row},{col})"
                );
                assert_eq!(
                    ca.hyperlink(),
                    cb.hyperlink(),
                    "{context}: link ({row},{col})"
                );
                assert_eq!(
                    ca.zerowidth(),
                    cb.zerowidth(),
                    "{context}: zw ({row},{col})"
                );
            }
        }
        assert_eq!(ga.cursor.point, gb.cursor.point, "{context}: cursor");
        assert_eq!(
            ga.cursor.input_needs_wrap, gb.cursor.input_needs_wrap,
            "{context}: pending wrap"
        );
        let mode_mask = !(TermMode::VI | TermMode::URGENCY_HINTS);
        assert_eq!(
            *a.term.mode() & mode_mask,
            *b.term.mode() & mode_mask,
            "{context}: mode"
        );
        assert_eq!(a.shadow.margins, b.shadow.margins, "{context}: margins");
        assert_eq!(
            a.shadow.active_charset, b.shadow.active_charset,
            "{context}: shift"
        );
        assert_eq!(a.shadow.alt, b.shadow.alt, "{context}: alt");
        // The primary register always travels, the alternate one while its
        // screen is active. An inactive alternate screen's register is not
        // carried (a limitation the module doc lists), nor is alacritty's
        // inactive grid compared.
        assert_eq!(
            a.shadow.saved_shift[0], b.shadow.saved_shift[0],
            "{context}: primary register shift"
        );
        if a.shadow.alt {
            assert_eq!(
                a.shadow.saved_shift[1], b.shadow.saved_shift[1],
                "{context}: alt register shift"
            );
        }
        assert_eq!(
            ga.cursor.charsets, gb.cursor.charsets,
            "{context}: charsets"
        );
        let (ta, tb) = (&ga.cursor.template, &gb.cursor.template);
        assert_eq!(
            (ta.fg, ta.bg, ta.flags & PEN_FLAGS),
            (tb.fg, tb.bg, tb.flags & PEN_FLAGS),
            "{context}: pen"
        );
        let (sa, sb) = (&ga.saved_cursor, &gb.saved_cursor);
        assert_eq!(sa.point, sb.point, "{context}: saved cursor point");
        assert_eq!(sa.charsets, sb.charsets, "{context}: saved cursor charsets");
        assert_eq!(
            (
                sa.template.fg,
                sa.template.bg,
                sa.template.flags & PEN_FLAGS
            ),
            (
                sb.template.fg,
                sb.template.bg,
                sb.template.flags & PEN_FLAGS
            ),
            "{context}: saved cursor pen"
        );
    }

    fn screen_text(e: &Emulator) -> Vec<String> {
        e.screen_text()
    }

    #[test]
    fn plain_text_and_colors() {
        let (a, b) = round_trip(
            20,
            5,
            b"plain \x1b[1;31mbold-red\x1b[0m\r\n\x1b[48;5;27mbg\x1b[0m tail",
        );
        assert_eq!(screen_text(&b)[0], "plain bold-red");
        assert_same_state(&a, &b, "colors");
    }

    #[test]
    fn truecolor_and_underline_styles() {
        let (a, b) = round_trip(
            30,
            4,
            b"\x1b[38;2;10;200;30mrgb\x1b[0m \x1b[4:3m\x1b[58;5;99mcurl\x1b[0m x",
        );
        assert_same_state(&a, &b, "truecolor");
    }

    #[test]
    fn wide_chars_and_combining() {
        let (a, b) = round_trip(10, 3, "ab\u{4f60}\u{597d} e\u{0301}\r\nok".as_bytes());
        assert_same_state(&a, &b, "wide");
    }

    #[test]
    fn cursor_position_round_trips() {
        let (a, b) = round_trip(20, 6, b"one\r\ntwo\x1b[3;7H");
        assert_same_state(&a, &b, "cursor");
    }

    #[test]
    fn pending_wrap_state_survives() {
        // Exactly fill the row so the wrap flag is armed but not yet taken.
        let (a, b) = round_trip(6, 3, b"abcdef");
        assert!(a.term.grid().cursor.input_needs_wrap, "precondition");
        assert_same_state(&a, &b, "pending-wrap");
    }

    #[test]
    fn soft_wrapped_lines_reflow_identically() {
        let (a, b) = round_trip(8, 4, b"0123456789abcdef XY");
        assert_same_state(&a, &b, "wrapline");
    }

    #[test]
    fn scroll_region_round_trips() {
        let input = b"\x1b[2;5r\x1b[2;1Hinside\r\nmore\r\nrows\r\nscrolls";
        let (mut a, mut b) = round_trip(20, 8, input);
        assert_same_state(&a, &b, "margins");
        // Behavioral proof: subsequent scrolling honors the region in both.
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b[5;1H\r\nnew-bottom");
        }
        assert_eq!(screen_text(&a), screen_text(&b), "post-scroll drift");
    }

    #[test]
    fn alt_screen_and_primary_both_survive() {
        let input = b"primary-content\x1b[?1049h\x1b[Halt-content";
        let (a, mut b) = round_trip(20, 5, input);
        assert_same_state(&a, &b, "alt");
        assert_eq!(screen_text(&b)[0], "alt-content");
        b.feed(b"\x1b[?1049l");
        assert_eq!(screen_text(&b)[0], "primary-content", "primary restored");
    }

    #[test]
    fn modes_round_trip() {
        let (a, b) = round_trip(
            20,
            5,
            b"x\x1b[?25l\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1h\x1b=\x1b[4h",
        );
        assert_same_state(&a, &b, "modes");
    }

    #[test]
    fn line_drawing_charset_round_trips() {
        // lqk in DEC special graphics: ┌ ─ ┐ ; glyphs are stored mapped.
        let (a, b) = round_trip(20, 4, b"\x1b(0lqk\x1b(Bplain\x0e");
        assert_same_state(&a, &b, "charset");
    }

    #[test]
    fn baseline_opens_with_the_shared_return_to_ascii() {
        // The screen chunk and the worker's replay head return a consumer to
        // ASCII with the same bytes; pinning the baseline to the shared
        // constant is what keeps the two from drifting.
        assert!(BASELINE.starts_with(b"\x1b[0m"), "{BASELINE:?}");
        assert!(
            BASELINE[4..].starts_with(RETURN_TO_ASCII),
            "the baseline's charset return is not RETURN_TO_ASCII: {BASELINE:?}"
        );
        assert_eq!(RETURN_TO_ASCII, b"\x1b(B\x1b)B\x1b*B\x1b+B\x0f");
    }

    /// A consumer the app left mid line-drawing: G0 and G1 designated to DEC
    /// special graphics and shifted out — what the previous checkpoint's tail
    /// or the app's own live bytes leave behind.
    const CONSUMER_MID_LINE_DRAWING: &[u8] = b"\x1b(0\x1b)0\x0e";

    #[test]
    fn checkpoint_mid_line_drawing_paints_text_on_a_consumer_left_in_line_drawing() {
        // #61: ncurses smacs mid-frame — the app designated line drawing, drew
        // a box top, returned to ASCII for "p1", then designated line drawing
        // again for the next box edge. The checkpoint lands there.
        let mut a = Emulator::new(20, 4);
        a.feed(b"\x1b(0lqk\x1b(Bp1\x1b(0");
        let checkpoint = a.serialize();

        let mut b = Emulator::new(20, 4);
        b.feed(CONSUMER_MID_LINE_DRAWING);
        b.feed(&checkpoint);
        assert_eq!(
            b.screen_text()[0],
            "┌─┐p1",
            "painted glyphs were mapped a second time: {:?}",
            b.screen_text()
        );
        assert_same_state(&a, &b, "mid line-drawing checkpoint");

        // The app carries on in its line-drawing set; the tail re-armed it in
        // the consumer, so both draw the same edge.
        for e in [&mut a, &mut b] {
            e.feed(b"x");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-checkpoint drift");
        assert_eq!(b.screen_text()[0], "┌─┐p1│");

        // The same over the alternate screen, where the baseline is mirrored
        // into self and the tail repairs the alt grid.
        let mut a = Emulator::new(20, 4);
        a.feed(b"\x1b[?1049h\x1b[H\x1b(0lqk\x1b(Bp1\x1b(0");
        let checkpoint = a.serialize();
        let mut b = Emulator::new(20, 4);
        b.feed(CONSUMER_MID_LINE_DRAWING);
        b.feed(&checkpoint);
        assert_eq!(b.screen_text()[0], "┌─┐p1", "{:?}", b.screen_text());
        assert_same_state(&a, &b, "mid line-drawing checkpoint, alt screen");
        for e in [&mut a, &mut b] {
            e.feed(b"x");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-checkpoint drift");
        assert_eq!(b.screen_text()[0], "┌─┐p1│");
    }

    #[test]
    fn replay_head_paints_history_as_text_on_a_consumer_left_in_line_drawing() {
        // The reviewer's reproduction on #60: the previous screen ended in
        // `ESC ( 0`, and the reseed's history `new abc` came back as glyphs.
        // The worker's replay head now returns the consumer to ASCII before
        // the committed lines, whether or not the client's clear did.
        use super::super::scrollback::replay_head;
        let mut c = Emulator::new(20, 4);
        c.feed(CONSUMER_MID_LINE_DRAWING);
        c.feed(b"\x1b[H\x1b[2J"); // a clear that returns no charset
        let mut replay = replay_head(20, 4);
        replay.extend_from_slice(b"\x1b[0mnew abc\r\n\x1b[0m");
        c.feed(&replay);
        assert_eq!(c.screen_text()[0], "new abc", "{:?}", c.screen_text());
    }

    #[test]
    fn checkpoint_keeps_the_emulators_own_charsets() {
        // The checkpoint must not move the emulator's own character sets: the
        // app still believes its sets are armed, and the emulator is what
        // renders its next bytes. Feeding the baseline's return into self
        // before capturing the sets — the alt path mirrors the baseline —
        // would leave the emulator in ASCII while the app draws boxes. The
        // shadow's record of the registers must survive too: the alt path
        // feeds the tail's own ESC 7 back into self, and one rebuilt under
        // the wrong shift would rewrite the record before anything compared
        // it (the app saves under SO here, so the two registers differ).
        for alt in [false, true] {
            let mut e = Emulator::new(20, 4);
            if alt {
                e.feed(b"\x1b[?1049h\x1b[H");
            }
            e.feed(b"\x1b(0\x1b)0\x0e\x1b7lqk");
            let state = |e: &Emulator| {
                (
                    e.term.grid().cursor.charsets,
                    e.shadow.active_charset,
                    e.shadow.saved_shift,
                    e.shadow.alt,
                )
            };
            let before = state(&e);
            assert_eq!(before.1, CharsetIndex::G1, "precondition");
            let mut registers = [CharsetIndex::G0; 2];
            registers[usize::from(alt)] = CharsetIndex::G1;
            assert_eq!(before.2, registers, "precondition");
            let checkpoint = e.serialize();
            assert_eq!(
                state(&e),
                before,
                "alt={alt}: the checkpoint changed the emulator's own charsets"
            );

            let mut b = Emulator::new(20, 4);
            b.feed(&checkpoint);
            for t in [&mut e, &mut b] {
                t.feed(b"x");
            }
            assert_eq!(e.screen_text()[0], "┌─┐│", "alt={alt}: emulator");
            assert_eq!(b.screen_text()[0], "┌─┐│", "alt={alt}: consumer");
        }
    }

    #[test]
    fn alt_screen_checkpoint_does_not_leak_the_primary_charsets_into_self() {
        // alacritty keeps designations per screen and copies the primary
        // cursor over the alt cursor when it swaps back. The baseline mirror
        // must land after that copy and return every slot, or the primary's
        // line-drawing G1 and G2 would survive in the alt grid where the app
        // had returned them to ASCII — and the next checkpoint would differ.
        let mut e = Emulator::new(20, 4);
        e.feed(b"\x1b)0\x1b*0"); // primary: G1 and G2 line drawing
        e.feed(b"\x1b[?1049h\x1b[H\x1b)B\x1b*B\x0e"); // alt: both ASCII again, SO
        let before = e.term.grid().cursor.charsets;
        let checkpoint = e.serialize();
        assert_eq!(e.term.grid().cursor.charsets, before, "leaked");
        assert_eq!(e.serialize(), checkpoint, "not stable");
        let mut b = Emulator::new(20, 4);
        b.feed(&checkpoint);
        assert_same_state(&e, &b, "alt after primary line drawing");
        for t in [&mut e, &mut b] {
            t.feed(b"x");
        }
        assert_eq!(e.screen_text()[0], "x", "emulator");
        assert_eq!(b.screen_text()[0], "x", "consumer");
    }

    #[test]
    fn shadow_records_the_shift_each_register_was_saved_under() {
        let mut e = Emulator::new(20, 4);
        e.feed(b"\x1b)0\x0e\x1b7"); // primary: saved under SO
        assert_eq!(e.shadow.saved_shift, [CharsetIndex::G1, CharsetIndex::G0]);
        e.feed(b"\x0f\x1b[?1049h"); // entering alt saves the primary under SI
        assert!(e.shadow.alt);
        assert_eq!(e.shadow.saved_shift, [CharsetIndex::G0, CharsetIndex::G0]);
        e.feed(b"\x0e\x1b[s"); // alt: CSI s under SO fills the alt register
        assert_eq!(e.shadow.saved_shift, [CharsetIndex::G0, CharsetIndex::G1]);
        e.feed(b"\x1b[?1049h"); // already there: not another entry
        assert_eq!(e.shadow.saved_shift, [CharsetIndex::G0, CharsetIndex::G1]);
        e.feed(b"\x1b[?1049l");
        assert!(!e.shadow.alt);
        e.feed(b"\x1bc"); // RIS
        assert_eq!(e.shadow, Shadow::new(4));
    }

    #[test]
    fn leaving_the_alt_screen_keeps_the_primary_charsets() {
        // The primary had line drawing designated when the app entered the
        // alternate screen and returned it to ASCII there. Leaving it must
        // bring the primary's set back in the consumer as in the emulator.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b(0\x1b[?1049h\x1b[H\x1b(Balt");
        assert_same_state(&a, &b, "alt over primary line drawing");
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b[?1049llqk");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-exit drift");
        assert_eq!(b.screen_text()[0], "┌─┐", "{:?}", b.screen_text());
        assert_eq!(
            a.term.grid().cursor.charsets,
            b.term.grid().cursor.charsets,
            "primary charsets"
        );

        // The SO form: the app entered the alternate screen shifted out with
        // G1 line drawing, and returned G1 to ASCII there. The entry is
        // rebuilt under that shift, so a consumer whose `?1049h` keeps the
        // active table gets line drawing back at `?1049l`, as the emulator
        // does.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b)0\x0e\x1b[?1049h\x1b[H\x1b)Balt");
        assert_same_state(&a, &b, "alt over primary SO line drawing");
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b[?1049lxxx");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-exit drift");
        assert_eq!(b.screen_text()[0], "│││", "{:?}", b.screen_text());
    }

    #[test]
    fn saved_cursor_keeps_its_charsets_across_a_checkpoint() {
        // ESC 7 with line drawing designated, back to ASCII for text, then
        // the checkpoint. The app's ESC 8 restores line drawing in a real
        // terminal, so it must in the consumer too.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b(0\x1b7\x1b(Btext");
        assert_same_state(&a, &b, "decsc charsets");
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b8lqk");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-restore drift");
        assert_eq!(b.screen_text()[0], "┌─┐t", "{:?}", b.screen_text());

        // The SO form (tmux/screen `smacs=^N`): G1 designated and shifted
        // out at ESC 7. The register is rebuilt under that shift, so a
        // consumer whose register holds the active table restores it too.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b)0\x0e\x1b7lqk");
        assert_same_state(&a, &b, "decsc charsets, SO form");
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b8xxx");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-restore drift");
        assert_eq!(b.screen_text()[0], "│││", "{:?}", b.screen_text());

        // Saved under SI with G0 line drawing, then shifted out before the
        // checkpoint: the register is rebuilt under the shift at ESC 7, not
        // the one at the checkpoint, or a consumer keeping the active table
        // would save G1's ASCII where the app saved G0's line drawing.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b(0\x1b7\x1b(B\x1b)0\x0e");
        assert_same_state(&a, &b, "decsc charsets, shifted since");
        for e in [&mut a, &mut b] {
            e.feed(b"\x0f\x1b8lqk");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-restore drift");
        assert_eq!(b.screen_text()[0], "┌─┐", "{:?}", b.screen_text());

        // Saved under SO and shifted in since (tmux-style smacs, DECSC,
        // rmacs): the register is rebuilt under SO, and the SI after its
        // ESC 7 is what puts the consumer back where the app is — the tail's
        // own shift only does so while the app is still shifted out.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b)0\x0e\x1b7\x0fab");
        assert_same_state(&a, &b, "decsc charsets, shifted in since");
        for e in [&mut a, &mut b] {
            e.feed(b"x");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-checkpoint drift");
        assert_eq!(b.screen_text()[0], "abx", "{:?}", b.screen_text());

        // On the alternate screen, saved under SO with G1 line drawing and
        // returned to ASCII since: the alt register is rebuilt under its own
        // recorded shift, not the primary's, and the mirror that feeds the
        // tail back into self must leave the shadow's record as it was.
        let (mut a, mut b) = round_trip(20, 4, b"\x1b[?1049h\x1b[H\x1b)0\x0e\x1b7\x1b)Btext");
        assert_eq!(
            a.shadow.saved_shift,
            [CharsetIndex::G0, CharsetIndex::G1],
            "alt register shift after the checkpoint"
        );
        assert_same_state(&a, &b, "decsc charsets, alt screen SO form");
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b8lqk");
        }
        assert_eq!(a.screen_text(), b.screen_text(), "post-restore drift");
        assert_eq!(b.screen_text()[0], "┌─┐t", "{:?}", b.screen_text());
    }

    #[test]
    fn serialize_is_stable_mid_line_drawing_on_the_alt_screen() {
        // Serializing twice mid line-drawing, alt screen active, yields the
        // same bytes: the mirror-and-repair leaves self exactly as it was.
        let mut e = Emulator::new(20, 5);
        e.feed(b"\x1b(0lqk\x1b7\r\nworld\x1b[?1049h\x1b[H\x1b)0\x0ealt");
        let first = e.serialize();
        let second = e.serialize();
        assert_eq!(first, second);
        let mut b = Emulator::new(20, 5);
        b.feed(&first);
        assert_same_state(&e, &b, "alt mid line-drawing");
    }

    /// Where the web workspace's xterm.js is. `SPAWN_XTERM_JS` names it and
    /// makes the proof required — `scripts/test-all.sh` sets it, so the one
    /// place that installs the web workspace never skips the only
    /// real-terminal proof in silence. Unset, the sibling `web/node_modules`
    /// is used when present and the test skips otherwise: `cargo test` also
    /// runs where no web workspace exists (the Windows check, the prebuilt
    /// runners), and a heuristic on `CI` failed exactly there.
    fn xterm_js() -> Option<std::path::PathBuf> {
        if let Some(named) = std::env::var_os("SPAWN_XTERM_JS") {
            let path = std::path::PathBuf::from(named);
            assert!(
                path.is_file(),
                "SPAWN_XTERM_JS names {}, which is not a file",
                path.display()
            );
            return Some(path);
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../web/node_modules/@xterm/xterm/lib/xterm.js");
        if path.is_file() {
            return Some(path);
        }
        eprintln!("skipped: no xterm.js at {}", path.display());
        None
    }

    /// Drive a real xterm.js, headless in node, through `writes` in order and
    /// return the screen rows after each one (`tests/xterm_checkpoint_proof.js`).
    fn real_xterm_rows(
        xterm: &std::path::Path,
        cols: u16,
        rows: u16,
        writes: &[&[u8]],
    ) -> Vec<Vec<String>> {
        use std::io::Write as _;
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/xterm_checkpoint_proof.js");
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let input = serde_json::json!({
            "xterm": xterm,
            "cols": cols,
            "rows": rows,
            "writes": writes.iter().map(|w| hex(w)).collect::<Vec<_>>(),
        });
        let mut node = std::process::Command::new("node")
            .arg(&script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .expect("node on PATH");
        node.stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(output.status.success(), "node exited {:?}", output.status);
        serde_json::from_slice(&output.stdout).expect("rows as JSON")
    }

    #[test]
    fn real_xterm_renders_a_mid_line_drawing_checkpoint_as_text() {
        // The same scenario as the alacritty consumer above, against the
        // xterm.js the browser and the phone's WebView render with.
        let Some(xterm) = xterm_js() else { return };
        use super::super::scrollback::replay_head;
        let mut a = Emulator::new(20, 4);
        a.feed(b"\x1b(0lqk\x1b(Bp1\x1b(0");
        let checkpoint = a.serialize();
        let mut reseed = b"\x1b[H\x1b[2J".to_vec(); // a clear with no charset return
        reseed.extend_from_slice(&replay_head(20, 4));
        reseed.extend_from_slice(b"\x1b[0mnew abc\r\n\x1b[0m");
        let rows = real_xterm_rows(
            &xterm,
            20,
            4,
            &[CONSUMER_MID_LINE_DRAWING, &checkpoint, b"x", &reseed],
        );
        assert_eq!(
            rows[1][0], "┌─┐p1",
            "xterm mapped the painted glyphs again: {rows:?}"
        );
        assert_eq!(
            rows[2][0], "┌─┐p1│",
            "the tail did not re-arm line drawing: {rows:?}"
        );
        assert_eq!(
            rows[3][0], "new abc",
            "history came back as glyphs: {rows:?}"
        );
    }

    #[test]
    fn real_xterm_restores_line_drawing_after_a_checkpointed_register() {
        // xterm.js keeps the active table in its DECSC register and the
        // primary's at `?1049h`, where alacritty keeps designations. The
        // rebuilt register and the carried primary sets must restore line
        // drawing on it all the same: DECSC in the G0 form, the SO form,
        // saved under SO then shifted in (where the register's rebuild must
        // not leave the consumer shifted out), saved under SI then shifted
        // out, and saved on the alternate screen under SO; and leaving the
        // alternate screen entered under SI and under SO.
        let Some(xterm) = xterm_js() else { return };
        let cases: [(&[u8], &[u8], &str); 7] = [
            (b"\x1b(0\x1b7\x1b(Btext", b"\x1b8lqk", "┌─┐t"),
            (b"\x1b)0\x0e\x1b7lqk", b"\x1b8xxx", "│││"),
            (b"\x1b)0\x0e\x1b7\x0fab", b"x", "abx"),
            (b"\x1b(0\x1b7\x1b(B\x1b)0\x0e", b"\x0f\x1b8lqk", "┌─┐"),
            (
                b"\x1b[?1049h\x1b[H\x1b)0\x0e\x1b7\x1b)Btext",
                b"\x1b8lqk",
                "┌─┐t",
            ),
            (
                b"\x1b(0\x1b[?1049h\x1b[H\x1b(Balt",
                b"\x1b[?1049llqk",
                "┌─┐",
            ),
            (
                b"\x1b)0\x0e\x1b[?1049h\x1b[H\x1b)Balt",
                b"\x1b[?1049lxxx",
                "│││",
            ),
        ];
        for (app, after, expected) in cases {
            let mut a = Emulator::new(20, 4);
            a.feed(app);
            let checkpoint = a.serialize();
            a.feed(after);
            assert_eq!(a.screen_text()[0], expected, "emulator: {app:?}");
            let rows = real_xterm_rows(&xterm, 20, 4, &[&checkpoint, after]);
            assert_eq!(rows[1][0], expected, "xterm after {app:?}: {rows:?}");
        }
    }

    #[test]
    fn hyperlinks_round_trip() {
        let (a, b) = round_trip(
            30,
            3,
            b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ done",
        );
        assert_same_state(&a, &b, "hyperlink");
    }

    #[test]
    fn cursor_style_round_trips() {
        let (a, b) = round_trip(10, 3, b"\x1b[5 qx");
        assert_same_state(&a, &b, "decscusr");
        assert_eq!(b.term.cursor_style().shape, CursorShape::Beam);
        assert!(b.term.cursor_style().blinking);
    }

    #[test]
    fn palette_overrides_round_trip() {
        let (a, b) = round_trip(10, 3, b"\x1b]4;1;rgb:12/34/56\x1b\\colored");
        assert_same_state(&a, &b, "palette");
        assert_eq!(a.term.colors()[1], b.term.colors()[1]);
        assert!(b.term.colors()[1].is_some());
    }

    #[test]
    fn tui_repaint_converges() {
        // A bottom-anchored frame like claude/codex draw: absolute cursor
        // addressing, EL-erased rewrites. Serialization of the final state
        // must not resurrect earlier frames.
        let mut input = Vec::new();
        input.extend_from_slice(b"transcript-1\r\ntranscript-2\r\n");
        for frame in 0..3 {
            input.extend_from_slice(
                format!("\x1b[8;1H\x1b[Kstatus-frame-{frame}\x1b[7;1H\x1b[Kbox-{frame}").as_bytes(),
            );
        }
        let (a, b) = round_trip(30, 8, &input);
        assert_same_state(&a, &b, "tui");
        let text = screen_text(&b).join("\n");
        assert!(!text.contains("frame-0"), "stale frame leaked: {text}");
        assert!(text.contains("status-frame-2"));
    }

    #[test]
    fn saved_cursor_survives_a_mid_frame_checkpoint() {
        // Ink-style frame: save cursor, paint a bottom box, restore. A
        // checkpoint between ESC 7 and ESC 8 must reproduce the register so
        // the replayed restore lands where the app expects.
        let (mut a, mut b) = round_trip(
            30,
            8,
            b"line-one\r\nline-two\x1b[33m\x1b7\x1b[8;1H\x1b[Kbox-frame",
        );
        assert_same_state(&a, &b, "decsc");
        for e in [&mut a, &mut b] {
            e.feed(b"\x1b8after-restore");
        }
        assert_eq!(screen_text(&a), screen_text(&b), "post-restore drift");
        assert!(
            screen_text(&b)[1].contains("after-restore"),
            "restore must return to the saved row: {:?}",
            screen_text(&b)
        );
    }

    #[test]
    fn resize_clears_margins() {
        let mut e = Emulator::new(20, 8);
        e.feed(b"\x1b[2;5r");
        assert!(e.shadow.margins.is_some());
        e.resize(30, 10);
        assert!(e.shadow.margins.is_none());
        assert_eq!(e.geometry(), (30, 10));
    }

    #[test]
    fn ed2_clear_does_not_commit_blank_padding() {
        // A full-screen TUI (claude/codex) repaints by clearing the screen.
        // On a tall, sparse phone screen the cleared viewport is mostly empty,
        // and ED 2 scrolls the whole viewport into history. The empty padding
        // must NOT be committed, or scrollback fills with blank bands.
        let mut e = Emulator::new(48, 29);
        // Content only near the bottom; the top ~26 rows are blank.
        e.feed_output(b"\x1b[27;1H> some prompt text\x1b[28;1H---footer---");
        let events = e.feed_output(b"\x1b[2J\x1b[Hredraw");
        let bytes = committed(&events);
        let text = String::from_utf8_lossy(&bytes);
        let blank = text
            .split('\n')
            .filter(|l| l.trim_end_matches('\r').trim().is_empty())
            .count();
        // The two content rows survive; the ~26 blank padding rows do not.
        assert!(text.contains("some prompt text"), "content lost: {text:?}");
        assert!(text.contains("---footer---"), "content lost: {text:?}");
        assert!(
            blank <= 2,
            "blank padding committed as a band: {blank} blank lines in {text:?}"
        );
    }

    #[test]
    fn ed2_clear_of_blank_screen_commits_nothing() {
        // Clearing an already-empty screen must add nothing to history.
        let mut e = Emulator::new(48, 29);
        let events = e.feed_output(b"\x1b[2J\x1b[H");
        assert!(
            committed(&events).is_empty(),
            "blank clear committed: {:?}",
            String::from_utf8_lossy(&committed(&events))
        );
    }

    #[test]
    fn authored_blank_line_at_batch_edge_is_preserved() {
        // A blank line between paragraphs is real output. While streaming it
        // constantly lands at a batch edge (content scrolls off in one drain,
        // the blank in the next). A short edge blank run must NOT be trimmed as
        // padding, or double newlines collapse to single across scrollback.
        let mut e = Emulator::new(20, 2);
        let mut out = Vec::new();
        out.extend(committed(&e.feed_output(b"A\r\n\r\n"))); // commits [A]; blank still on screen
        out.extend(committed(&e.feed_output(b"B\r\nC\r\nD"))); // scrolls off [blank, B]
                                                               // Committed history is A, blank, B (C and D remain on screen). The
                                                               // single blank between A and B is a leading edge run well under half a
                                                               // screenful, so it survives.
        let rows = render_lines(20, 10, &out);
        assert_eq!(rows[0], "A", "history: {rows:?}");
        assert_eq!(
            rows[1], "",
            "authored blank between A and B was trimmed: {rows:?}"
        );
        assert_eq!(rows[2], "B", "history: {rows:?}");
    }

    #[test]
    fn interior_blank_band_is_dropped() {
        // A sparse screen (content low, blank above) scrolls its blank rows off
        // between content — a blank band in the INTERIOR of a batch, the shape
        // that wedged a screenful of blank at the history↔live-screen seam.
        // A run at least half a screenful tall is padding and must be dropped,
        // even when it is not at a batch edge.
        let mut e = Emulator::new(20, 8); // band_min = 4
                                          // "top", a 6-row blank band, "bottom", then rows to scroll them all off.
        let feed = b"top\r\n\r\n\r\n\r\n\r\n\r\n\r\nbottom\r\nx\r\nx\r\nx\r\nx\r\nx\r\nx\r\nx\r\nx";
        let text = render_lines(20, 30, &committed(&e.feed_output(feed)));
        let ti = text.iter().position(|l| l == "top").expect("top committed");
        let bi = text
            .iter()
            .position(|l| l == "bottom")
            .expect("bottom committed");
        assert!(
            bi - ti - 1 < 4,
            "interior blank band survived: {} blanks between top and bottom: {text:?}",
            bi - ti - 1
        );
    }

    #[test]
    fn serialize_is_stable() {
        // Serializing twice without new input yields identical bytes
        // (serialize must not mutate observable state).
        let mut e = Emulator::new(20, 5);
        e.feed(b"\x1b[31mhello\x1b[0m\r\nworld\x1b[?1049h\x1b[Halt");
        let first = e.serialize();
        let second = e.serialize();
        assert_eq!(first, second);
    }

    /// Concatenate the Lines payloads of a feed's events (test convenience).
    fn committed(events: &[HistoryEvent]) -> Vec<u8> {
        let mut out = Vec::new();
        for event in events {
            if let HistoryEvent::Lines(lines) = event {
                out.extend_from_slice(lines);
            }
        }
        out
    }

    /// Render committed-line bytes in a fresh terminal and return its rows.
    fn render_lines(cols: u16, rows: u16, lines: &[u8]) -> Vec<String> {
        let mut viewer = Emulator::new(cols, rows);
        viewer.feed(lines);
        viewer.screen_text()
    }

    #[test]
    fn scrolled_lines_commit_and_repaints_do_not() {
        let mut e = Emulator::new(20, 3);
        let events = e.feed_output(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        let text = render_lines(20, 5, &committed(&events));
        assert_eq!(text[0], "one", "oldest committed line first: {text:?}");
        assert_eq!(text[1], "two");
        assert!(text[2].is_empty(), "screen rows must not commit: {text:?}");

        // A bottom-anchored repaint (claude/codex style) rewrites in place:
        // nothing scrolls, nothing commits.
        let events = e.feed_output(b"\x1b[3;1H\x1b[Kstatus-9\x1b[2;1H\x1b[Kbox-9");
        assert!(committed(&events).is_empty(), "in-place repaint committed");
    }

    #[test]
    fn committed_lines_keep_styling() {
        let mut e = Emulator::new(20, 2);
        let events = e.feed_output(b"\x1b[1;31mred\x1b[0m ok\r\nnext\r\nlast");
        let mut viewer = Emulator::new(20, 4);
        viewer.feed(&committed(&events));
        assert_eq!(viewer.screen_text()[0], "red ok");
        let grid = viewer.term.grid();
        let cell = &grid[Line(0)][Column(0)];
        assert_eq!(cell.fg, Color::Named(NamedColor::Red), "fg lost in commit");
        assert!(cell.flags.contains(Flags::BOLD), "bold lost in commit");
    }

    #[test]
    fn wrapped_logical_lines_commit_without_breaks() {
        let mut e = Emulator::new(8, 2);
        // 20 chars wrap across 3 rows at cols=8; scroll them fully off.
        let events = e.feed_output(b"abcdefghijklmnopqrst\r\n1\r\n2\r\n3\r\n4");
        let bytes = committed(&events);
        // Rendered wider, the logical line must reassemble on one row.
        let text = render_lines(40, 6, &bytes);
        assert_eq!(
            text[0], "abcdefghijklmnopqrst",
            "wrap not reassembled: {text:?}"
        );
    }

    #[test]
    fn clear_screen_commits_viewport_then_wipe_truncates() {
        let mut e = Emulator::new(20, 3);
        e.feed_output(b"seen-1\r\nseen-2\r\nseen-3\r\nseen-4");
        // ED 2 alone (plain `clear`): the viewport scrolls into history.
        let events = e.feed_output(b"\x1b[2J\x1b[H");
        let text = render_lines(20, 6, &committed(&events)).join("\n");
        assert!(
            text.contains("seen-4"),
            "ED 2 must commit the viewport: {text}"
        );

        // A later ED 3 truncates previously committed history.
        let events = e.feed_output(b"\x1b[3J");
        assert!(
            matches!(events.as_slice(), [HistoryEvent::Truncate]),
            "ED 3 must surface as a truncate"
        );
    }

    #[test]
    fn clear_terminal_triple_orders_truncate_after_doomed_commits() {
        // The claude/codex `/clear`: ESC[2J ESC[3J ESC[H in one chunk. The
        // 2J-pushed viewport is cleared by the 3J inside the grid itself, so
        // the net event stream is a bare truncate — nothing pre-clear may
        // survive it.
        let mut e = Emulator::new(20, 3);
        e.feed_output(b"old-1\r\nold-2\r\nold-3\r\nold-4");
        let events = e.feed_output(b"\x1b[2J\x1b[3J\x1b[H");
        let survivors = committed(&events);
        let position = events
            .iter()
            .position(|event| matches!(event, HistoryEvent::Truncate))
            .expect("truncate event");
        assert!(
            survivors.is_empty() || position == 0,
            "content committed before the truncate would resurrect cleared history"
        );
        assert!(matches!(events[position], HistoryEvent::Truncate));
    }

    #[test]
    fn wipe_sequence_split_across_feeds_still_truncates() {
        let mut e = Emulator::new(20, 3);
        e.feed_output(b"x\r\ny\r\nz\r\nw");
        assert!(committed(&e.feed_output(b"\x1b[")).is_empty());
        let events = e.feed_output(b"3J");
        assert!(
            events
                .iter()
                .any(|event| matches!(event, HistoryEvent::Truncate)),
            "split ESC[3J missed"
        );
        // DECSED form too.
        e.feed_output(b"a\r\nb\r\nc\r\nd");
        let events = e.feed_output(b"\x1b[?3J");
        assert!(events
            .iter()
            .any(|event| matches!(event, HistoryEvent::Truncate)));
    }

    #[test]
    fn sgr_params_containing_three_do_not_truncate() {
        let mut e = Emulator::new(20, 3);
        e.feed_output(b"p\r\nq\r\nr\r\ns");
        let events = e.feed_output(b"\x1b[38;5;196mred\x1b[0m\x1b[33myellow\x1b[m");
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, HistoryEvent::Truncate)),
            "SGR misread as a scrollback wipe"
        );
    }

    #[test]
    fn shrinking_rows_commits_displaced_lines() {
        let mut e = Emulator::new(20, 6);
        e.feed_output(b"r1\r\nr2\r\nr3\r\nr4\r\nr5\r\nr6");
        let events = e.resize(20, 3);
        let text = render_lines(20, 8, &committed(&events)).join("\n");
        assert!(
            text.contains("r1"),
            "rows displaced by a shrink must commit: {text}"
        );
        // The screen still holds the tail.
        assert!(e.screen_text().join("\n").contains("r6"));
    }

    #[test]
    fn alt_screen_scrolling_never_commits() {
        let mut e = Emulator::new(20, 3);
        e.feed_output(b"shell-1\r\nshell-2");
        let events = e.feed_output(b"\x1b[?1049h\x1b[Hv1\r\nv2\r\nv3\r\nv4\r\nv5");
        assert!(
            committed(&events).is_empty(),
            "alt-screen scroll must not pollute history"
        );
        let events = e.feed_output(b"\x1b[?1049l");
        assert!(committed(&events).is_empty());
        assert_eq!(e.screen_text()[0], "shell-1", "primary restored");
    }

    #[test]
    fn large_bursts_commit_every_line() {
        // A burst far beyond one drain stride: every line must commit exactly
        // once, in order.
        let mut e = Emulator::new(20, 4);
        let mut input = Vec::new();
        for i in 0..500 {
            input.extend_from_slice(format!("line-{i:04}\r\n").as_bytes());
        }
        let events = e.feed_output(&input);
        let bytes = committed(&events);
        let text = String::from_utf8_lossy(&bytes);
        let count = text.matches("line-").count();
        // Everything scrolled off except what the 4-row screen retains.
        assert_eq!(count, 500 - 3, "committed line count: {count}");
        assert!(text.find("line-0000").unwrap() < text.find("line-0001").unwrap());
    }

    /// Diagnostic (scratch): feed a recorded PTY byte stream through the
    /// commit engine and dump the committed history + final screen as text.
    /// SPAWN_RECORDING=path SPAWN_RECORDING_GEOM=colsxrows SPAWN_RECORDING_CHUNK=n
    #[test]
    #[ignore]
    fn commit_recording_dump() {
        let path = std::env::var("SPAWN_RECORDING").expect("SPAWN_RECORDING");
        let geom = std::env::var("SPAWN_RECORDING_GEOM").unwrap_or_else(|_| "100x30".into());
        let chunk: usize = std::env::var("SPAWN_RECORDING_CHUNK")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4096);
        let (cols, rows) = geom.split_once('x').expect("geom colsxrows");
        let (cols, rows): (u16, u16) = (cols.parse().unwrap(), rows.parse().unwrap());
        let bytes = std::fs::read(&path).unwrap();

        let mut e = Emulator::new(cols, rows);
        let mut history: Vec<u8> = Vec::new();
        let mut truncates = 0;
        for part in bytes.chunks(chunk) {
            for event in e.feed_output(part) {
                match event {
                    HistoryEvent::Lines(lines) => history.extend_from_slice(&lines),
                    HistoryEvent::Truncate => {
                        truncates += 1;
                        history.clear();
                    }
                }
            }
        }

        let line_count = history.windows(2).filter(|w| w == b"\r\n").count();
        let mut viewer = Emulator::new(cols, (line_count as u16).saturating_add(4).max(4));
        viewer.feed(&history);
        let text = viewer.screen_text();
        let last = text
            .iter()
            .rposition(|l| !l.is_empty())
            .map_or(0, |i| i + 1);
        println!(
            "== committed history ({} bytes, {line_count} hard lines, {truncates} truncates) ==",
            history.len()
        );
        for (i, line) in text[..last].iter().enumerate() {
            println!("{i:5} |{line}|");
        }
        println!("== final screen ==");
        for (i, line) in e.screen_text().iter().enumerate() {
            println!("{i:5} |{line}|");
        }
    }
}
