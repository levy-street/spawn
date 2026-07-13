#!/usr/bin/env python3
"""Generate the conformance corpus: raw-byte case files + manifest.json.

Run from anywhere:  python3 corpus/build_corpus.py
Regenerates corpus/cases/*.bin and corpus/manifest.json deterministically.
The .bin files are committed; this script is the authoritative source.
"""
from __future__ import annotations

import json
import pathlib

ESC = "\x1b"
CSI = ESC + "["


def cup(row: int, col: int) -> str:
    """CUP, 1-based."""
    return f"{CSI}{row};{col}H"


def sgr(*params: int | str) -> str:
    return CSI + ";".join(str(p) for p in params) + "m"


CASES: list[dict] = []


def case(name: str, description: str, data: str, cols: int = 80, rows: int = 24) -> None:
    CASES.append(
        {
            "name": name,
            "description": description,
            "cols": cols,
            "rows": rows,
            "file": f"cases/{name}.bin",
            "_data": data,
        }
    )


# ---------------------------------------------------------------- cursor movement

case(
    "cursor-cup",
    "CUP absolute positioning to corners and center; cursor left mid-screen.",
    cup(1, 1) + "TOPLEFT"
    + cup(12, 40) + "CENTER"
    + cup(24, 1) + "BOTTOMLEFT"
    + cup(1, 74) + "TOPRIGHT"
    + cup(3, 5),
)

case(
    "cursor-relative",
    "CUU/CUD/CUF/CUB relative movement, including clamping at the top edge.",
    cup(10, 10) + "S"
    + f"{CSI}5B" + "down5"
    + f"{CSI}10C" + "right10"
    + f"{CSI}3A" + "up3"
    + f"{CSI}8D" + "left8"
    + f"{CSI}99A" + "T",  # clamps at row 1
)

case(
    "cursor-save-restore-decsc",
    "DECSC/DECRC (ESC 7 / ESC 8) save-restore including SGR state.",
    cup(5, 5) + sgr(31) + "red"
    + ESC + "7"
    + cup(15, 30) + sgr(0) + sgr(34) + "blue-elsewhere"
    + ESC + "8"
    + "R",  # drawn at 5;8 in red if SGR restored
)

case(
    "cursor-save-restore-ansi",
    "ANSI save/restore cursor (CSI s / CSI u), position only.",
    cup(6, 20) + f"{CSI}s"
    + cup(20, 60) + "moved"
    + f"{CSI}u" + "X",
)

# ---------------------------------------------------------------- SGR / colors

case(
    "sgr-16color",
    "Standard fg 30-37, bright fg 90-97, bg 40-47, bright bg 100-107.",
    cup(1, 1)
    + "".join(sgr(30 + i) + f"f{i}" for i in range(8)) + sgr(0)
    + cup(2, 1)
    + "".join(sgr(90 + i) + f"F{i}" for i in range(8)) + sgr(0)
    + cup(3, 1)
    + "".join(sgr(40 + i) + f"b{i}" for i in range(8)) + sgr(0)
    + cup(4, 1)
    + "".join(sgr(100 + i) + f"B{i}" for i in range(8)) + sgr(0),
)

case(
    "sgr-256color",
    "Indexed 256-color fg (38;5;n) and bg (48;5;n) samples from cube and grayscale ramp.",
    cup(1, 1)
    + "".join(sgr(38, 5, n) + f"[{n}]" for n in (33, 99, 129, 160, 214, 245)) + sgr(0)
    + cup(2, 1)
    + "".join(sgr(48, 5, n) + f"[{n}]" for n in (17, 52, 93, 220, 236)) + sgr(0),
)

case(
    "sgr-truecolor",
    "24-bit truecolor fg (38;2) and bg (48;2), including combined fg+bg.",
    cup(1, 1) + sgr(38, 2, 255, 100, 0) + "orange" + sgr(0)
    + cup(2, 1) + sgr(48, 2, 10, 20, 30) + "on-dark" + sgr(0)
    + cup(3, 1) + sgr(38, 2, 1, 2, 3, 48, 2, 250, 251, 252) + "both" + sgr(0),
)

case(
    "sgr-attributes",
    "Each attribute alone (bold, dim, italic, underline, blink, inverse, strikethrough) then explicit removal codes.",
    cup(1, 1) + sgr(1) + "bold" + sgr(0)
    + cup(2, 1) + sgr(2) + "dim" + sgr(0)
    + cup(3, 1) + sgr(3) + "italic" + sgr(0)
    + cup(4, 1) + sgr(4) + "underline" + sgr(0)
    + cup(5, 1) + sgr(5) + "blink" + sgr(0)
    + cup(6, 1) + sgr(7) + "inverse" + sgr(0)
    + cup(7, 1) + sgr(9) + "strike" + sgr(0)
    + cup(8, 1) + sgr(1, 4, 5) + "on" + sgr(22) + sgr(24) + sgr(25) + "off",
)

case(
    "sgr-combos",
    "Attribute+color combos with selective resets (24, 39, 49) rather than SGR 0.",
    cup(1, 1)
    + sgr(1, 4, 31, 43) + "all"
    + sgr(24) + "no-ul"
    + sgr(39) + "def-fg"
    + sgr(49) + "def-bg"
    + sgr(0) + "plain",
)

# ---------------------------------------------------------------- wrapping

case(
    "wrap-autowrap-on",
    "DECAWM on (default): 60 chars wrap across 40-col lines.",
    cup(1, 1) + "".join(chr(ord("A") + (i % 26)) for i in range(60)),
    cols=40,
    rows=10,
)

case(
    "wrap-autowrap-off",
    "DECAWM off (CSI ?7l): overflow overwrites the last column instead of wrapping.",
    f"{CSI}?7l"
    + cup(1, 1) + "".join(chr(ord("A") + (i % 26)) for i in range(60))
    + f"{CSI}?7h",
    cols=40,
    rows=10,
)

case(
    "wrap-wide-at-edge",
    "Wide CJK char that does not fit in the last column wraps whole to the next line.",
    cup(1, 78) + "ab漢"  # 漢 needs cols 80-81 -> wraps to row 2
    + cup(3, 79) + "字"   # fits exactly in cols 79-80
    + cup(5, 1),
)

# ---------------------------------------------------------------- scroll regions

case(
    "scroll-region-lf",
    "DECSTBM 3;10 with LF-driven scrolling inside the region; outside rows untouched.",
    cup(1, 1) + "above-region"
    + cup(12, 1) + "below-region"
    + f"{CSI}3;10r"
    + cup(3, 1) + "line-a\r\nline-b\r\nline-c\r\nline-d\r\nline-e\r\nline-f\r\nline-g\r\nline-h\r\nline-i\r\nline-j\r\nline-k\r\nline-l"
    + f"{CSI}r",
)

case(
    "scroll-region-ri",
    "RI (ESC M) at the top of a DECSTBM region scrolls the region down.",
    f"{CSI}5;15r"
    + cup(5, 1) + "top-of-region"
    + cup(7, 1) + "third-row"
    + cup(5, 1) + ESC + "M" + "pushed-down-1"
    + cup(5, 1) + ESC + "M" + "pushed-down-2"
    + f"{CSI}r",
)

# ---------------------------------------------------------------- clears

case(
    "ed-clear-below-above",
    "Fill screen, then ED 1 (above+left) at 6;40 and ED 0 (below+right) at 18;40.",
    "".join(cup(r, 1) + (f"row{r:02d}-" + "x" * 70)[:80] for r in range(1, 25))
    + cup(6, 40) + f"{CSI}1J"
    + cup(18, 40) + f"{CSI}0J",
)

case(
    "ed-clear-all",
    "Fill screen then ED 2; cursor position must survive; marker drawn after.",
    "".join(cup(r, 1) + "junk" for r in range(1, 25))
    + cup(9, 9) + f"{CSI}2J" + "M",
)

case(
    "el-clears",
    "EL 0 (right), EL 1 (left, incl. cursor cell), EL 2 (whole line) on three filled rows.",
    cup(1, 1) + "R" * 80 + cup(2, 1) + "L" * 80 + cup(3, 1) + "W" * 80
    + cup(1, 40) + f"{CSI}0K"
    + cup(2, 40) + f"{CSI}1K"
    + cup(3, 40) + f"{CSI}2K"
    + cup(5, 1) + "done",
)

# ---------------------------------------------------------------- alt screen

case(
    "altscreen-roundtrip",
    "Enter 1049 alt screen, draw, exit; main screen content and cursor restored.",
    cup(2, 2) + "main-content"
    + f"{CSI}?1049h"
    + cup(5, 5) + sgr(32) + "alt-only" + sgr(0)
    + f"{CSI}?1049l"
    + "!",
)

case(
    "altscreen-active",
    "Enter 1049 alt screen and stay there; altScreen flag true, alt content visible.",
    cup(2, 2) + "hidden-main"
    + f"{CSI}?1049h"
    + cup(3, 3) + "alt-visible",
)

# ---------------------------------------------------------------- line/char edits

case(
    "il-dl",
    "IL (CSI L) inserts blank lines pushing content down; DL (CSI M) deletes lines pulling up.",
    "".join(cup(r, 1) + f"orig-{r}" for r in range(1, 7))
    + cup(2, 1) + f"{CSI}2L" + "inserted"
    + cup(5, 1) + f"{CSI}1M",
)

case(
    "ich-dch",
    "ICH (CSI @) inserts blanks shifting right; DCH (CSI P) deletes shifting left.",
    cup(1, 1) + "ABCDEFGHIJ"
    + cup(1, 3) + f"{CSI}3@"
    + cup(2, 1) + "0123456789"
    + cup(2, 4) + f"{CSI}2P"
    + cup(4, 1),
)

# ---------------------------------------------------------------- tabs

case(
    "tabs-hts-tbc",
    "Default 8-col tab stops; HTS sets custom stops; TBC 3 clears all (tab then jumps to last column).",
    cup(1, 1) + "\ta\tb\tc"
    + cup(2, 5) + ESC + "H" + cup(2, 13) + ESC + "H"
    + cup(2, 1) + "\tX\tY"
    + f"{CSI}3g"
    + cup(3, 1) + "\tZ",
)

# ---------------------------------------------------------------- origin mode / RI

case(
    "origin-mode-decom",
    "DECOM: CUP becomes relative to the DECSTBM region top; reset afterwards.",
    f"{CSI}5;15r{CSI}?6h"
    + cup(1, 1) + "at-region-top"
    + cup(3, 10) + "region-r3c10"
    + f"{CSI}?6l{CSI}r",
)

case(
    "reverse-index-top",
    "RI at the true top of the screen scrolls the whole screen down one line.",
    cup(1, 1) + "first"
    + cup(2, 1) + "second"
    + cup(1, 1) + ESC + "M" + "new-top",
)

# ---------------------------------------------------------------- unicode

case(
    "wide-cjk",
    "Wide CJK glyphs interleaved with ASCII; continuation cells must be width-0.",
    cup(1, 1) + "A漢B字C"
    + cup(2, 1) + "テスト"
    + cup(3, 1) + sgr(35) + "色付き" + sgr(0),
)

case(
    "combining-chars",
    "Combining marks attach to the preceding cell; precomposed form on next row for comparison.",
    cup(1, 1) + "é ä o̲"
    + cup(2, 1) + "é ä"
    + cup(4, 1),
)

# ---------------------------------------------------------------- OSC title

case(
    "osc-title",
    "OSC 2 (BEL-terminated) then OSC 0 (ST-terminated); final title wins.",
    ESC + "]2;first title\x07"
    + cup(1, 1) + "titled"
    + ESC + "]0;final title" + ESC + "\\",
)


def main() -> None:
    root = pathlib.Path(__file__).resolve().parent
    cases_dir = root / "cases"
    cases_dir.mkdir(exist_ok=True)

    manifest = []
    for c in CASES:
        data = c.pop("_data").encode("utf-8")
        (root / c["file"]).write_bytes(data)
        manifest.append(c)

    (root / "manifest.json").write_text(
        json.dumps({"version": 1, "cases": manifest}, indent=2) + "\n"
    )
    print(f"wrote {len(manifest)} cases to {cases_dir}")


if __name__ == "__main__":
    main()
