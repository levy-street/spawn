"""Local pseudo-oracle: replay corpus bytes through pyte and emit grid-state v1.

pyte is NOT the reference oracle (iTerm2 is); it exists so the whole pipeline
runs end-to-end on Linux. Genuine xterm.js-vs-pyte behavioral divergences are
expected and are tracked in known-divergences.json — they prove the differ
catches real differences.

Known pyte limitations relevant here:
- No alternate screen buffer: DECSET 1049 is tracked in Screen.mode but the
  buffer is not switched, so altscreen-* cases diverge on content.
- No SGR 2 (dim/faint) support: `dim` is always reported False.
- 256-color SGRs are stored as hex; we map them back to palette indices via
  pyte's own palette table so representation matches emulators that store
  indices (truecolor values that exactly collide with a palette entry are
  reported as that index — corpus cases avoid such values).
"""
from __future__ import annotations

import pathlib
import sys
from importlib.metadata import version as pkg_version

import pyte
import pyte.graphics

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "common"))
import gridstate  # noqa: E402

_NAMED_TO_INDEX = {
    "black": 0,
    "red": 1,
    "green": 2,
    "brown": 3,  # pyte's name for ANSI yellow
    "blue": 4,
    "magenta": 5,
    "cyan": 6,
    "white": 7,
    "brightblack": 8,
    "brightred": 9,
    "brightgreen": 10,
    "brightbrown": 11,
    "brightblue": 12,
    "brightmagenta": 13,
    "brightcyan": 14,
    "brightwhite": 15,
    # pyte 0.8.2 ships a typo in graphics.BG_AIXTERM[105] ("bfightmagenta");
    # accept it so SGR 105 backgrounds still map to bright magenta.
    "bfightmagenta": 13,
}

# pyte stores SGR 38;5;n / 48;5;n as FG_BG_256[n]; invert it (first index wins
# for the handful of duplicate hex values, preferring 0-15).
_HEX_TO_INDEX: dict[str, int] = {}
for _i, _hex in enumerate(pyte.graphics.FG_BG_256):
    _HEX_TO_INDEX.setdefault(_hex, _i)


def _color(value: str) -> gridstate.Color:
    if value == "default":
        return "default"
    if value in _NAMED_TO_INDEX:
        return _NAMED_TO_INDEX[value]
    if len(value) == 6:
        try:
            int(value, 16)
        except ValueError:
            pass
        else:
            if value in _HEX_TO_INDEX:
                return _HEX_TO_INDEX[value]
            return f"#{value.lower()}"
    raise ValueError(f"unrecognized pyte color: {value!r}")


ALTBUF_MODES = {47 << 5, 1047 << 5, 1049 << 5}


def run_case(data: bytes, cols: int, rows: int, case: str | None) -> dict:
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    stream.feed(data)

    grid: list[list[dict]] = []
    for y in range(rows):
        line = screen.buffer[y]
        row: list[dict] = []
        for x in range(cols):
            ch = line[x]  # StaticDefaultDict: missing cells yield default_char
            text = ch.data
            if text == "":
                width = 0  # wide-char continuation stub
            else:
                # Lead cell of a wide char iff the next cell is a stub.
                width = 2 if (x + 1 < cols and line[x + 1].data == "") else 1
                if text == " " or text == "\x00":
                    text = " "
            row.append(
                {
                    "text": text,
                    "width": width,
                    "fg": _color(ch.fg),
                    "bg": _color(ch.bg),
                    "bold": bool(ch.bold),
                    "dim": False,  # pyte does not implement SGR 2
                    "italic": bool(ch.italics),
                    "underline": bool(ch.underscore),
                    "inverse": bool(ch.reverse),
                    "strikethrough": bool(ch.strikethrough),
                    "blink": bool(ch.blink),
                }
            )
        grid.append(row)

    return gridstate.make_state(
        producer_name="pyte",
        producer_version=pkg_version("pyte"),
        case=case,
        cols=cols,
        rows=rows,
        cursor_row=screen.cursor.y,
        cursor_col=screen.cursor.x,
        cursor_visible=not screen.cursor.hidden,
        alt_screen=any(m in screen.mode for m in ALTBUF_MODES),
        title=screen.title,
        grid=grid,
    )


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="raw-bytes corpus case file")
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--name", default=None)
    args = parser.parse_args()

    data = pathlib.Path(args.file).read_bytes()
    state = run_case(data, args.cols, args.rows, args.name)
    gridstate.validate_state(state, source=args.file)
    print(json.dumps(state))


if __name__ == "__main__":
    main()
