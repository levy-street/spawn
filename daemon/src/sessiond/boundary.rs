//! Escape-sequence boundary tracking for the PTY output stream.
//!
//! Checkpoints must land between escape sequences: a rotation that splits an
//! SGR (or a UTF-8 code point) puts the tail of the sequence at the head of
//! the next segment, and a replay starting there opens with parser garbage.
//! This scanner tracks just enough VT/UTF-8 framing to answer "is this byte
//! position a safe split point" — no terminal semantics, no allocation.

/// Where the stream currently sits relative to escape/UTF-8 framing.
#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Ground,
    /// After a bare ESC.
    Escape,
    /// ESC intermediates (0x20–0x2F), awaiting a final byte.
    EscapeIntermediate,
    /// Inside CSI, awaiting a final byte (0x40–0x7E).
    Csi,
    /// Inside an OSC/DCS/SOS/PM/APC string, terminated by BEL or ST.
    OpaqueString,
    /// Saw ESC inside an opaque string (potential ST).
    OpaqueStringEscape,
}

pub struct SeqScanner {
    state: State,
    /// Remaining UTF-8 continuation bytes expected (ground text only).
    utf8_left: u8,
}

impl Default for SeqScanner {
    fn default() -> Self {
        Self {
            state: State::Ground,
            utf8_left: 0,
        }
    }
}

impl SeqScanner {
    pub fn at_boundary(&self) -> bool {
        self.state == State::Ground && self.utf8_left == 0
    }

    /// Advance through `bytes`, returning the earliest count `n` (1..=len)
    /// such that the stream is at a boundary after `bytes[..n]` — while
    /// still consuming the whole slice so scanner state stays current.
    pub fn first_boundary(&mut self, bytes: &[u8]) -> Option<usize> {
        let mut found = None;
        for (i, &b) in bytes.iter().enumerate() {
            self.advance(b);
            if found.is_none() && self.at_boundary() {
                found = Some(i + 1);
            }
        }
        found
    }

    /// Advance through `bytes` without querying boundaries.
    pub fn scan(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.advance(b);
        }
    }

    fn advance(&mut self, byte: u8) {
        // CAN and SUB abort any sequence in progress.
        if byte == 0x18 || byte == 0x1a {
            self.state = State::Ground;
            self.utf8_left = 0;
            return;
        }
        match self.state {
            State::Ground => {
                if self.utf8_left > 0 {
                    // Continuation byte expected; anything else resyncs.
                    if byte & 0xc0 == 0x80 {
                        self.utf8_left -= 1;
                        return;
                    }
                    self.utf8_left = 0;
                }
                match byte {
                    0x1b => self.state = State::Escape,
                    0xc0..=0xdf => self.utf8_left = 1,
                    0xe0..=0xef => self.utf8_left = 2,
                    0xf0..=0xf7 => self.utf8_left = 3,
                    _ => {}
                }
            }
            State::Escape => {
                self.state = match byte {
                    b'[' => State::Csi,
                    b']' | b'P' | b'X' | b'^' | b'_' => State::OpaqueString,
                    0x20..=0x2f => State::EscapeIntermediate,
                    0x1b => State::Escape,
                    _ => State::Ground, // final byte (ESC 7, ESC =, ESC c, …)
                };
            }
            State::EscapeIntermediate => {
                if !(0x20..=0x2f).contains(&byte) {
                    self.state = State::Ground; // final byte (charset etc.)
                }
            }
            State::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    self.state = State::Ground;
                }
                // 0x20–0x3F: params/intermediates; C0 bytes execute inline —
                // either way the CSI continues.
            }
            State::OpaqueString => match byte {
                0x07 => self.state = State::Ground, // BEL terminator
                0x1b => self.state = State::OpaqueStringEscape,
                _ => {}
            },
            State::OpaqueStringEscape => {
                // ESC \ is ST; any other escape effectively ends the string
                // and starts a new sequence.
                self.state = match byte {
                    b'\\' => State::Ground,
                    b'[' => State::Csi,
                    b']' | b'P' | b'X' | b'^' | b'_' => State::OpaqueString,
                    0x20..=0x2f => State::EscapeIntermediate,
                    0x1b => State::Escape,
                    _ => State::Ground,
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundaries(input: &[u8]) -> Vec<usize> {
        let mut s = SeqScanner::default();
        let mut out = Vec::new();
        for (i, &b) in input.iter().enumerate() {
            s.advance(b);
            if s.at_boundary() {
                out.push(i + 1);
            }
        }
        out
    }

    #[test]
    fn plain_text_is_all_boundaries() {
        assert_eq!(boundaries(b"abc"), vec![1, 2, 3]);
    }

    #[test]
    fn csi_is_atomic() {
        // No boundary inside ESC [ 3 8 ; 5 ; 4 2 m
        assert_eq!(boundaries(b"\x1b[38;5;42m"), vec![10]);
    }

    #[test]
    fn osc_with_st_is_atomic() {
        let seq = b"\x1b]8;;https://x\x1b\\ok";
        assert_eq!(boundaries(seq), vec![16, 17, 18]);
    }

    #[test]
    fn osc_with_bel_is_atomic() {
        assert_eq!(boundaries(b"\x1b]0;title\x07z"), vec![10, 11]);
    }

    #[test]
    fn utf8_code_points_are_atomic() {
        // "你" = e4 bd a0
        assert_eq!(boundaries("你a".as_bytes()), vec![3, 4]);
    }

    #[test]
    fn esc7_and_charset_finals() {
        assert_eq!(boundaries(b"\x1b7"), vec![2]);
        assert_eq!(boundaries(b"\x1b(0x"), vec![3, 4]);
    }

    #[test]
    fn split_chunks_keep_state() {
        let mut s = SeqScanner::default();
        s.scan(b"\x1b[38;2;1");
        assert!(!s.at_boundary());
        assert_eq!(s.first_boundary(b"0;20;30mX"), Some(8));
        assert!(s.at_boundary());
    }

    #[test]
    fn can_sub_abort() {
        assert_eq!(boundaries(b"\x1b[12\x18x"), vec![5, 6]);
    }
}
