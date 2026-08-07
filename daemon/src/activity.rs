//! Streaming output-activity classification. The daemon consumes every PTY
//! byte in source order and emits only content-free activity metadata.
//!
//! Terminal sequences and UTF-8 code points can be split across arbitrary PTY
//! reads, so classification is deliberately stateful per agent. CSI/OSC
//! parsing uses constant state; there is no intermediate terminal status bar
//! whose repaint needs content-specific filtering.

use std::time::Duration;

/// Throttle: at most one output-activity ping per agent per this interval.
pub const OUTPUT_TOUCH_INTERVAL: Duration = Duration::from_secs(2);
/// Throttle: at most one input-activity ping per agent per this interval.
pub const INPUT_TOUCH_INTERVAL: Duration = Duration::from_secs(1);
/// After local input, suppress the echo from counting as agent work.
pub const INPUT_ECHO_SUPPRESS_WINDOW: Duration = Duration::from_millis(750);
/// After an injected resize/redraw, suppress the resulting repaint.
pub const REDRAW_SUPPRESS_WINDOW: Duration = Duration::from_millis(1500);
/// Legacy debounce interval retained by the forwarder scheduler. Worker output
/// no longer creates ambiguous daemon-side status repaint candidates.
pub const OUTPUT_IDLE_RESOLUTION_DELAY: Duration = Duration::from_millis(250);

const MIN_MEANINGFUL_OUTPUT_CHARS: u8 = 3;

#[derive(Clone, Copy, Debug)]
struct ObservedChar {
    value: char,
    eligible: bool,
}

#[derive(Debug, Default)]
enum TerminalState {
    #[default]
    Ground,
    Escape,
    CsiParams,
    CsiIntermediate,
    Osc {
        escape_pending: bool,
    },
    Charset,
}

/// Per-agent streaming classifier. `observe` must be called for every PTY
/// chunk, including chunks received while output activity is throttled or
/// suppressed. `eligible` controls whether visible characters from this chunk
/// may contribute to activity while parser state always advances.
#[derive(Debug)]
pub struct OutputClassifier {
    terminal: TerminalState,
    utf8: Vec<(u8, bool)>,
    meaningful_chars: u8,
}

impl Default for OutputClassifier {
    fn default() -> Self {
        Self {
            terminal: TerminalState::Ground,
            utf8: Vec::new(),
            meaningful_chars: 0,
        }
    }
}

impl OutputClassifier {
    pub fn observe(&mut self, payload: &[u8], eligible: bool) -> bool {
        let mut meaningful = false;
        for &byte in payload {
            self.consume_terminal_byte(byte, eligible, &mut meaningful);
        }
        if meaningful {
            // This observation has already represented all visible text it
            // consumed; do not let a remainder from the same PTY chunk become
            // a second, delayed event after throttle expiry.
            self.discard_meaningful_carry();
        }
        meaningful
    }

    /// Worker output has no daemon-generated status repaint ambiguity.
    pub fn needs_idle_resolution(&self) -> bool {
        false
    }

    /// No delayed content decision remains in the worker-only pipeline.
    pub fn resolve_idle(&mut self) -> bool {
        false
    }

    /// Do not let sub-threshold text observed during a closed throttle window
    /// turn into a delayed activity event after that window expires.
    pub fn discard_meaningful_carry(&mut self) {
        self.meaningful_chars = 0;
    }

    fn consume_terminal_byte(&mut self, byte: u8, eligible: bool, meaningful: &mut bool) {
        let mut pending = Some(byte);
        while let Some(current) = pending.take() {
            match std::mem::take(&mut self.terminal) {
                TerminalState::Ground => {
                    self.consume_ground_byte(current, eligible, meaningful);
                }
                TerminalState::Escape => match current {
                    b'[' => self.terminal = TerminalState::CsiParams,
                    b']' => {
                        self.terminal = TerminalState::Osc {
                            escape_pending: false,
                        }
                    }
                    b'(' | b')' => self.terminal = TerminalState::Charset,
                    _ => pending = Some(current),
                },
                TerminalState::CsiParams => match current {
                    0x30..=0x3f => self.terminal = TerminalState::CsiParams,
                    0x20..=0x2f => self.terminal = TerminalState::CsiIntermediate,
                    0x40..=0x7e => {}
                    _ => pending = Some(current),
                },
                TerminalState::CsiIntermediate => match current {
                    0x20..=0x2f => self.terminal = TerminalState::CsiIntermediate,
                    0x40..=0x7e => {}
                    _ => pending = Some(current),
                },
                TerminalState::Osc { escape_pending } => {
                    if current == 0x07 || (escape_pending && current == b'\\') {
                        // BEL and ST terminate OSC.
                    } else {
                        self.terminal = TerminalState::Osc {
                            escape_pending: current == 0x1b,
                        };
                    }
                }
                TerminalState::Charset => {
                    if !current.is_ascii_alphanumeric() {
                        // The former regex did not consume an invalid final;
                        // process it normally after discarding ESC + `(`/`)`.
                        pending = Some(current);
                    }
                }
            }
        }
    }

    fn consume_ground_byte(&mut self, byte: u8, eligible: bool, meaningful: &mut bool) {
        if byte.is_ascii() {
            // An ASCII byte cannot continue an incomplete multibyte sequence;
            // match UTF-8 `errors="ignore"` by dropping that malformed carry.
            self.utf8.clear();
            match byte {
                0x1b => {
                    self.terminal = TerminalState::Escape;
                }
                b'\r' | b'\n' => {}
                0x00..=0x08 | 0x0b..=0x1f | 0x7f => {}
                _ => self.consume_visible_char(
                    ObservedChar {
                        value: byte as char,
                        eligible,
                    },
                    meaningful,
                ),
            }
            return;
        }

        self.utf8.push((byte, eligible));
        loop {
            let bytes: Vec<u8> = self.utf8.iter().map(|(byte, _)| *byte).collect();
            match std::str::from_utf8(&bytes) {
                Ok(text) => {
                    let char_eligible = self.utf8.iter().all(|(_, eligible)| *eligible);
                    let chars: Vec<char> = text.chars().collect();
                    self.utf8.clear();
                    for value in chars {
                        self.consume_visible_char(
                            ObservedChar {
                                value,
                                eligible: char_eligible,
                            },
                            meaningful,
                        );
                    }
                    break;
                }
                Err(error) => match error.error_len() {
                    None => break,
                    Some(invalid_len) => {
                        let valid_up_to = error.valid_up_to();
                        if valid_up_to > 0 {
                            let valid_eligible = self.utf8[..valid_up_to]
                                .iter()
                                .all(|(_, eligible)| *eligible);
                            let valid = std::str::from_utf8(&bytes[..valid_up_to]).unwrap();
                            for value in valid.chars() {
                                self.consume_visible_char(
                                    ObservedChar {
                                        value,
                                        eligible: valid_eligible,
                                    },
                                    meaningful,
                                );
                            }
                        }
                        self.utf8.drain(..valid_up_to + invalid_len);
                        if self.utf8.is_empty() {
                            break;
                        }
                    }
                },
            }
        }
    }

    fn consume_visible_char(&mut self, observed: ObservedChar, meaningful: &mut bool) {
        self.record_char(observed, meaningful);
    }

    fn record_char(&mut self, observed: ObservedChar, meaningful: &mut bool) {
        if !observed.eligible || observed.value.is_whitespace() {
            return;
        }
        self.meaningful_chars += 1;
        if self.meaningful_chars >= MIN_MEANINGFUL_OUTPUT_CHARS {
            *meaningful = true;
            self.meaningful_chars = 0;
        }
    }

    #[cfg(test)]
    fn buffered_len(&self) -> usize {
        self.utf8.len() + usize::from(self.meaningful_chars)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_with_split(payload: &[u8], split: usize) -> bool {
        let mut classifier = OutputClassifier::default();
        classifier.observe(&payload[..split], true) || classifier.observe(&payload[split..], true)
    }

    fn assert_every_split(payload: &[u8], expected: bool) {
        for split in 0..=payload.len() {
            assert_eq!(
                classify_with_split(payload, split),
                expected,
                "unexpected classification at byte split {split} for {payload:?}"
            );
        }
        let mut classifier = OutputClassifier::default();
        let mut bytewise = false;
        for byte in payload {
            bytewise |= classifier.observe(std::slice::from_ref(byte), true);
        }
        assert_eq!(
            bytewise, expected,
            "unexpected classification with every byte boundary split for {payload:?}"
        );
    }

    #[test]
    fn plain_and_utf8_output_carries_across_every_boundary() {
        assert_every_split(b"abc", true);
        assert_every_split("•••".as_bytes(), true);
        assert_every_split(b"ok", false);
    }

    #[test]
    fn csi_carries_across_every_boundary() {
        assert_every_split(b"\x1b[38;5;42mabc\x1b[0m", true);
        assert_every_split(b"\x1b[2;5H\x1b[K\x1b[0m", false);
    }

    #[test]
    fn osc_carries_across_every_boundary() {
        assert_every_split(b"\x1b]0;private title\x07abc", true);
        assert_every_split(b"\x1b]0;private title\x1b\\", false);
    }

    #[test]
    fn charset_escape_carries_across_every_boundary() {
        assert_every_split(b"\x1b(Babc", true);
        assert_every_split(b"\x1b(0\x1b)B", false);
    }

    #[test]
    fn quoted_real_output_without_newline_is_not_held_as_status() {
        assert_every_split(b"\"quoted real output\"", true);
    }

    #[test]
    fn malformed_utf8_is_ignored_but_valid_replacement_chars_remain() {
        assert_every_split(b"\xff\xfe\xfd", false);
        assert_every_split(b"a\xffbc", true);
        assert_every_split("���".as_bytes(), true);
        assert_every_split(b"abc\xe2\x82", true);
    }

    #[test]
    fn unterminated_control_carry_is_bounded() {
        let mut osc = OutputClassifier::default();
        assert!(!osc.observe(b"\x1b]0;", true));
        for _ in 0..10_000 {
            assert!(!osc.observe(b"secret title content", true));
            assert!(osc.buffered_len() <= 4);
        }
    }
}

/// Streaming classifier for the browser→agent direction.
///
/// Not every byte arriving on the data channel is someone typing. A terminal
/// answers questions the application asked it — where the cursor is, whether
/// it has focus, where the mouse went — and xterm.js emits those replies
/// through the same path as keystrokes. Counting them as input makes an agent
/// report "Input sent" because somebody clicked on it to see what it was
/// doing, which is exactly when the badge should say nothing at all.
///
/// The distinction is directional rather than structural: arrow keys and
/// replies are both CSI sequences, so shape alone cannot separate them. In
/// this direction, though, the final byte can. `I`/`O` are focus in/out,
/// `R` a cursor-position report, `n` a device-status reply, `c` a device
/// attributes reply, `t` a window report, and `M`/`m` mouse tracking — none
/// of which any key produces. Everything else, CSI or not, is a person.
///
/// Stateful because a sequence can be split across data-channel messages, and
/// half a report must not read as input on the strength of its first half.
#[derive(Debug, Default)]
pub struct InputClassifier {
    state: InputState,
}

#[derive(Debug, Default, PartialEq)]
enum InputState {
    #[default]
    Ground,
    Escape,
    /// `had_params` separates the two mouse encodings, which share a final
    /// byte: bare `ESC [ M` is X10 and swallows three coordinate bytes, while
    /// `ESC [ < 0;1;1 M` is SGR and ends there. Reading SGR as X10 eats the
    /// three bytes after it, which is usually the keystroke that followed.
    CsiParams {
        had_params: bool,
    },
    CsiIntermediate,
    /// X10 mouse: `ESC [ M` is followed by exactly three raw bytes, which are
    /// coordinates and can hold any value, including ESC.
    X10Mouse(u8),
    /// OSC and DCS both run to a string terminator; replies to colour and
    /// terminfo queries arrive this way.
    StringUntilTerminator {
        escape_pending: bool,
    },
}

/// CSI finals that only a terminal sends, never a key.
fn is_report_final(byte: u8) -> bool {
    matches!(byte, b'I' | b'O' | b'R' | b'n' | b'c' | b't' | b'M' | b'm')
}

impl InputClassifier {
    /// True when `payload` contains anything a person could have produced.
    /// Must be called for every chunk so the parser stays aligned.
    pub fn observe(&mut self, payload: &[u8]) -> bool {
        let mut user = false;
        for &byte in payload {
            self.consume(byte, &mut user);
        }
        user
    }

    fn consume(&mut self, byte: u8, user: &mut bool) {
        match std::mem::take(&mut self.state) {
            InputState::Ground => match byte {
                0x1b => self.state = InputState::Escape,
                // A bare ESC is a keypress, but it is indistinguishable from
                // the start of a sequence until the next byte arrives, so it
                // is charged to whatever follows.
                _ => *user = true,
            },
            InputState::Escape => match byte {
                b'[' => self.state = InputState::CsiParams { had_params: false },
                b']' | b'P' | b'X' | b'^' | b'_' => {
                    self.state = InputState::StringUntilTerminator {
                        escape_pending: false,
                    }
                }
                // ESC ESC, alt-modified keys, SS3 function keys: all typed.
                _ => *user = true,
            },
            InputState::CsiParams { had_params } => match byte {
                0x30..=0x3f => self.state = InputState::CsiParams { had_params: true },
                0x20..=0x2f => self.state = InputState::CsiIntermediate,
                b'M' if !had_params => self.state = InputState::X10Mouse(0),
                0x40..=0x7e => {
                    if !is_report_final(byte) {
                        *user = true;
                    }
                }
                // Malformed: treat the stray byte as ground rather than
                // silently swallowing real input after it.
                _ => *user = true,
            },
            InputState::CsiIntermediate => match byte {
                0x20..=0x2f => self.state = InputState::CsiIntermediate,
                0x40..=0x7e => {
                    if !is_report_final(byte) {
                        *user = true;
                    }
                }
                _ => *user = true,
            },
            InputState::X10Mouse(seen) => {
                if seen < 2 {
                    self.state = InputState::X10Mouse(seen + 1);
                }
            }
            InputState::StringUntilTerminator { escape_pending } => {
                if byte == 0x07 || (escape_pending && byte == b'\\') {
                    // Terminated.
                } else {
                    self.state = InputState::StringUntilTerminator {
                        escape_pending: byte == 0x1b,
                    };
                }
            }
        }
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;

    fn observe_every_split(payload: &[u8], expected: bool) {
        for split in 0..=payload.len() {
            let mut classifier = InputClassifier::default();
            let got = classifier.observe(&payload[..split]) | classifier.observe(&payload[split..]);
            assert_eq!(got, expected, "split {split} of {payload:?}");
        }
        let mut bytewise = InputClassifier::default();
        let mut got = false;
        for byte in payload {
            got |= bytewise.observe(std::slice::from_ref(byte));
        }
        assert_eq!(got, expected, "byte-at-a-time {payload:?}");
    }

    #[test]
    fn terminal_replies_are_not_input() {
        observe_every_split(b"\x1b[I", false); // focus in
        observe_every_split(b"\x1b[O", false); // focus out
        observe_every_split(b"\x1b[24;80R", false); // cursor position report
        observe_every_split(b"\x1b[0n", false); // device status
        observe_every_split(b"\x1b[?1;2c", false); // primary device attributes
        observe_every_split(b"\x1b[>0;276;0c", false); // secondary device attributes
        observe_every_split(b"\x1b[8;24;80t", false); // window size report
    }

    #[test]
    fn mouse_tracking_is_not_input() {
        observe_every_split(b"\x1b[<0;24;12M", false); // SGR press
        observe_every_split(b"\x1b[<0;24;12m", false); // SGR release
        observe_every_split(b"\x1b[M\x20\x21\x22", false); // X10
    }

    #[test]
    fn x10_mouse_coordinates_are_never_read_as_input() {
        // Coordinates are raw bytes and may legitimately be ESC or a letter;
        // reading them as content would make a click look like typing.
        observe_every_split(b"\x1b[M\x1b\x1b\x1b", false);
        observe_every_split(b"\x1b[Mabc", false);
    }

    #[test]
    fn keystrokes_are_input() {
        observe_every_split(b"a", true);
        observe_every_split(b"\r", true);
        observe_every_split(b"\x03", true); // ctrl-c
        observe_every_split(b"\x1b[A", true); // up arrow
        observe_every_split(b"\x1b[1;5C", true); // ctrl-right
        observe_every_split(b"\x1bOP", true); // F1 via SS3
        observe_every_split(b"\x1b[3~", true); // delete
        observe_every_split(b"\x1b\x1b", true); // escape pressed twice
    }

    #[test]
    fn a_reply_followed_by_typing_still_counts() {
        observe_every_split(b"\x1b[Ihello", true);
        observe_every_split(b"\x1b[<0;1;1Mx", true);
    }

    #[test]
    fn bracketed_paste_is_input() {
        observe_every_split(b"\x1b[200~pasted\x1b[201~", true);
    }

    #[test]
    fn osc_and_dcs_replies_are_not_input() {
        observe_every_split(b"\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\", false);
        observe_every_split(b"\x1bP1+r544e=787465726d\x1b\\", false);
    }
}
