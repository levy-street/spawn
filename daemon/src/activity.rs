//! Streaming output-activity classification. The daemon consumes every PTY
//! byte in source order and emits only content-free activity metadata.
//!
//! Terminal sequences and UTF-8 code points can be split across arbitrary PTY
//! reads, so classification is deliberately stateful per agent. Carry is
//! bounded: CSI/OSC parsing uses constant state and plausible tmux status text
//! is capped before being flushed through ordinary content classification.

use std::time::Duration;

/// Throttle: at most one output-activity ping per agent per this interval.
pub const OUTPUT_TOUCH_INTERVAL: Duration = Duration::from_secs(2);
/// Throttle: at most one input-activity ping per agent per this interval.
pub const INPUT_TOUCH_INTERVAL: Duration = Duration::from_secs(1);
/// After local input, suppress the echo from counting as agent work.
pub const INPUT_ECHO_SUPPRESS_WINDOW: Duration = Duration::from_millis(750);
/// After an injected resize/redraw, suppress the resulting repaint.
pub const REDRAW_SUPPRESS_WINDOW: Duration = Duration::from_millis(1500);

const MIN_MEANINGFUL_OUTPUT_CHARS: u8 = 3;
const MAX_STATUS_CARRY_CHARS: usize = 512;

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

#[derive(Debug, Default)]
enum TextState {
    #[default]
    Normal,
    Candidate(Vec<ObservedChar>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CandidateState {
    Possible,
    CompleteNoise,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClockState {
    Prefix,
    Complete,
    Invalid,
}

/// Per-agent streaming classifier. `observe` must be called for every PTY
/// chunk, including chunks received while output activity is throttled or
/// suppressed. `eligible` controls whether visible characters from this chunk
/// may contribute to activity while parser state always advances.
#[derive(Debug)]
pub struct OutputClassifier {
    terminal: TerminalState,
    text: TextState,
    utf8: Vec<(u8, bool)>,
    meaningful_chars: u8,
    segment_has_visible: bool,
    segment_has_leading_whitespace: bool,
}

impl Default for OutputClassifier {
    fn default() -> Self {
        Self {
            terminal: TerminalState::Ground,
            text: TextState::Normal,
            utf8: Vec::new(),
            meaningful_chars: 0,
            segment_has_visible: false,
            segment_has_leading_whitespace: false,
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
            self.meaningful_chars = 0;
        }
        meaningful
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
                    // A cursor/control sequence is a visible-text boundary.
                    // Flush anything merely status-like so an incomplete
                    // fragment cannot swallow subsequent TUI output.
                    self.finish_text_segment(meaningful);
                    self.terminal = TerminalState::Escape;
                }
                b'\r' | b'\n' => self.finish_text_segment(meaningful),
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
        match std::mem::take(&mut self.text) {
            TextState::Normal => {
                if observed.value.is_whitespace() {
                    if !self.segment_has_visible {
                        self.segment_has_leading_whitespace = true;
                    }
                    return;
                }
                let can_start_status = !self.segment_has_visible
                    && (observed.value == '['
                        || observed.value.is_ascii_digit()
                        || (observed.value == '"' && self.segment_has_leading_whitespace));
                self.segment_has_visible = true;
                if can_start_status {
                    self.text = TextState::Candidate(vec![observed]);
                    self.evaluate_candidate(meaningful);
                } else {
                    self.record_char(observed, meaningful);
                }
            }
            TextState::Candidate(mut carry) => {
                carry.push(observed);
                if carry.len() > MAX_STATUS_CARRY_CHARS {
                    // Ambiguity is bounded, not content: once the cap is hit,
                    // flush as real output and resume ordinary classification.
                    self.text = TextState::Normal;
                    for observed in carry {
                        self.record_char(observed, meaningful);
                    }
                } else {
                    self.text = TextState::Candidate(carry);
                    self.evaluate_candidate(meaningful);
                }
            }
        }
    }

    fn evaluate_candidate(&mut self, meaningful: &mut bool) {
        let TextState::Candidate(carry) = &self.text else {
            return;
        };
        let text: String = carry.iter().map(|item| item.value).collect();
        match candidate_state(&text) {
            CandidateState::Possible => {}
            CandidateState::CompleteNoise => {
                self.text = TextState::Normal;
                self.segment_has_visible = false;
                self.segment_has_leading_whitespace = false;
            }
            CandidateState::Invalid => {
                let TextState::Candidate(carry) = std::mem::take(&mut self.text) else {
                    unreachable!()
                };
                for observed in carry {
                    self.record_char(observed, meaningful);
                }
            }
        }
    }

    fn finish_text_segment(&mut self, meaningful: &mut bool) {
        match std::mem::take(&mut self.text) {
            TextState::Candidate(carry) => {
                // A complete status is discarded as soon as its final digit is
                // observed. Anything still merely plausible at EOL is real
                // visible text and must be classified.
                for observed in carry {
                    self.record_char(observed, meaningful);
                }
            }
            TextState::Normal => {}
        }
        self.segment_has_visible = false;
        self.segment_has_leading_whitespace = false;
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
        let text = match &self.text {
            TextState::Candidate(carry) => carry.len(),
            TextState::Normal => 0,
        };
        self.utf8.len() + text + usize::from(self.meaningful_chars)
    }
}

fn candidate_state(text: &str) -> CandidateState {
    const SPAWN_PREFIX: &str = "[spawn-";
    if SPAWN_PREFIX.starts_with(text) {
        return CandidateState::Possible;
    }
    if text.starts_with(SPAWN_PREFIX) {
        // A `[spawn-` prefix alone is only ambiguous. Discard it only after a
        // complete status clock is present; CSI/EOL/carry-cap boundaries flush
        // incomplete fragments as real content.
        for (index, value) in text.char_indices() {
            if value.is_ascii_digit() && clock_state(&text[index..]) == ClockState::Complete {
                return CandidateState::CompleteNoise;
            }
        }
        return CandidateState::Possible;
    }
    if let Some(rest) = text.strip_prefix('"') {
        let Some(closing_quote) = rest.find('"') else {
            return CandidateState::Possible;
        };
        let after_title = &rest[closing_quote + 1..];
        if after_title.is_empty() {
            return CandidateState::Possible;
        }
        if !after_title.starts_with(char::is_whitespace) {
            return CandidateState::Invalid;
        }
        let clock = after_title.trim_start_matches(char::is_whitespace);
        if clock.is_empty() {
            return CandidateState::Possible;
        }
        return match clock_state(clock) {
            ClockState::Prefix => CandidateState::Possible,
            ClockState::Complete => CandidateState::CompleteNoise,
            ClockState::Invalid => CandidateState::Invalid,
        };
    }
    if text.starts_with(|value: char| value.is_ascii_digit()) {
        return match clock_state(text) {
            ClockState::Prefix => CandidateState::Possible,
            ClockState::Complete => CandidateState::CompleteNoise,
            ClockState::Invalid => CandidateState::Invalid,
        };
    }
    CandidateState::Invalid
}

fn clock_state(text: &str) -> ClockState {
    let bytes = text.as_bytes();
    let mut index = 0;

    macro_rules! expect_byte {
        ($predicate:expr) => {
            if index == bytes.len() {
                return ClockState::Prefix;
            }
            if !$predicate(bytes[index]) {
                return ClockState::Invalid;
            }
            index += 1;
        };
    }

    for _ in 0..2 {
        expect_byte!(|byte: u8| byte.is_ascii_digit());
    }
    expect_byte!(|byte| byte == b':');
    for _ in 0..2 {
        expect_byte!(|byte: u8| byte.is_ascii_digit());
    }
    expect_byte!(|byte: u8| byte.is_ascii_whitespace());
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    for _ in 0..2 {
        expect_byte!(|byte: u8| byte.is_ascii_digit());
    }
    expect_byte!(|byte| byte == b'-');
    for _ in 0..3 {
        expect_byte!(|byte: u8| byte.is_ascii_alphabetic());
    }
    expect_byte!(|byte| byte == b'-');
    for _ in 0..2 {
        expect_byte!(|byte: u8| byte.is_ascii_digit());
    }

    if index == bytes.len() {
        ClockState::Complete
    } else {
        ClockState::Invalid
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
    fn tmux_noise_carries_across_every_boundary() {
        assert_every_split(b"[spawn-oem] \"bash\" 12:34 15-Jul-26", false);
        assert_every_split(b"           \"project\" 04:49 08-May-26", false);
        assert_every_split(b"12:34 15-Jul-26", false);
    }

    #[test]
    fn status_fragments_recover_at_csi_before_real_output_at_every_boundary() {
        assert_every_split(b"[spawn-oem] \"bash\" 12:34 15-Jul-26\x1b[10;1Habc", true);
        assert_every_split(b"[spawn-incomplete\x1b[10;1Habc", true);
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
    fn unterminated_control_and_ambiguous_status_carry_is_bounded() {
        let mut osc = OutputClassifier::default();
        assert!(!osc.observe(b"\x1b]0;", true));
        for _ in 0..10_000 {
            assert!(!osc.observe(b"secret title content", true));
            assert!(osc.buffered_len() <= MAX_STATUS_CARRY_CHARS);
        }

        let mut fragment = OutputClassifier::default();
        assert!(!fragment.observe(b"[spawn-", true));
        let mut fragment_flushed = false;
        for _ in 0..10_000 {
            fragment_flushed |= fragment.observe(b"x", true);
            assert!(fragment.buffered_len() <= MAX_STATUS_CARRY_CHARS);
        }
        assert!(
            fragment_flushed,
            "overlong spawn-like text was never classified"
        );

        let mut quote = OutputClassifier::default();
        // Leading whitespace makes this plausibly the tmux title+clock suffix.
        assert!(!quote.observe(b" \"", true));
        let mut quote_flushed = false;
        for _ in 0..10_000 {
            quote_flushed |= quote.observe(b"unterminated", true);
            assert!(quote.buffered_len() <= MAX_STATUS_CARRY_CHARS);
        }
        assert!(quote_flushed, "overlong quoted text was never classified");
    }

    #[test]
    fn overlong_ambiguous_status_then_cursor_and_real_output_recovers() {
        let mut classifier = OutputClassifier::default();
        let mut meaningful = classifier.observe(b" \"", true);
        for _ in 0..(MAX_STATUS_CARRY_CHARS + 10) {
            meaningful |= classifier.observe(b"x", true);
            assert!(classifier.buffered_len() <= MAX_STATUS_CARRY_CHARS);
        }
        meaningful |= classifier.observe(b"\x1b[20;1Hreal output", true);
        assert!(meaningful);
    }
}
