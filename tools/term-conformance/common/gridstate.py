"""Shared grid-state (schema v1) helpers: compaction, validation, normalization.

Used by the pyte oracle, the iTerm2 oracle, the differ, and the driver.
"""
from __future__ import annotations

import functools
import json
import pathlib
import typing
import unicodedata

SCHEMA_VERSION = 1
ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schema" / "grid-state.schema.json"

STYLE_FLAGS = (
    "bold",
    "dim",
    "italic",
    "underline",
    "inverse",
    "strikethrough",
    "blink",
)

DEFAULT_CELL: dict[str, typing.Any] = {
    "text": " ",
    "width": 1,
    "fg": "default",
    "bg": "default",
    **{flag: False for flag in STYLE_FLAGS},
}

Color = typing.Union[str, int, None]  # "default" | 0..255 | "#rrggbb" | None


def compact_cell(cell: dict) -> dict:
    """Drop fields equal to schema defaults. A blank cell compacts to {}."""
    return {k: v for k, v in cell.items() if k in DEFAULT_CELL and v != DEFAULT_CELL[k]}


def compact_rows(rows: list[list[dict]]) -> list[list[dict]]:
    """Compact every cell and trim trailing all-default cells from each row."""
    out = []
    for row in rows:
        compacted = [compact_cell(c) for c in row]
        while compacted and not compacted[-1]:
            compacted.pop()
        out.append(compacted)
    return out


def make_state(
    *,
    producer_name: str,
    producer_version: str | None,
    case: str | None,
    cols: int,
    rows: int,
    cursor_row: int,
    cursor_col: int,
    cursor_visible: bool | None,
    alt_screen: bool | None,
    title: str | None,
    grid: list[list[dict]],
) -> dict:
    """Assemble a schema-v1 document from full (non-compacted) cells."""
    state = {
        "version": SCHEMA_VERSION,
        "producer": {"name": producer_name, "version": producer_version},
        "size": {"cols": cols, "rows": rows},
        "cursor": {
            "row": max(0, min(cursor_row, rows - 1)),
            "col": max(0, min(cursor_col, cols - 1)),
            "visible": cursor_visible,
        },
        "altScreen": alt_screen,
        "title": title,
        "rows": compact_rows(grid),
    }
    if case is not None:
        state["case"] = case
    return state


@functools.cache
def _validator():
    import jsonschema

    schema = json.loads(SCHEMA_PATH.read_text())
    return jsonschema.Draft202012Validator(schema)


def validate_state(state: dict, source: str = "<state>") -> None:
    """Raise ValueError with readable context if `state` violates the schema."""
    errors = sorted(_validator().iter_errors(state), key=lambda e: list(e.absolute_path))
    if errors:
        first = errors[0]
        where = "/".join(str(p) for p in first.absolute_path) or "<root>"
        raise ValueError(f"{source}: schema violation at {where}: {first.message} (+{len(errors) - 1} more)")


def normalize_text(text: str) -> str:
    """NFC-normalize; an empty width>=1 cell equals a space (handled upstream)."""
    return unicodedata.normalize("NFC", text)


def expand_cell(cell: dict) -> dict:
    """Inverse of compact_cell: fill omitted fields with defaults."""
    return {**DEFAULT_CELL, **cell}


def expand_rows(state: dict) -> list[list[dict]]:
    """Full size.rows x size.cols grid with every field present."""
    cols = state["size"]["cols"]
    rows_n = state["size"]["rows"]
    out = []
    for y in range(rows_n):
        row = state["rows"][y] if y < len(state["rows"]) else []
        expanded = [expand_cell(c) for c in row[:cols]]
        while len(expanded) < cols:
            expanded.append(dict(DEFAULT_CELL))
        out.append(expanded)
    return out


# --- color semantics ---------------------------------------------------------

_CUBE_LEVELS = (0, 95, 135, 175, 215, 255)


def palette_rgb(index: int) -> str | None:
    """Canonical #rrggbb for palette indices >= 16 (6x6x6 cube + grayscale ramp).

    Indices 0-15 return None: their RGB values are theme-dependent, so an
    indexed 0-15 color only ever equals the same index.
    """
    if index < 16:
        return None
    if index < 232:
        i = index - 16
        r = _CUBE_LEVELS[i // 36]
        g = _CUBE_LEVELS[(i // 6) % 6]
        b = _CUBE_LEVELS[i % 6]
    else:
        r = g = b = 8 + 10 * (index - 232)
    return f"#{r:02x}{g:02x}{b:02x}"


def colors_equal(a: Color, b: Color) -> bool | None:
    """True/False, or None if either side is a wildcard (null)."""
    if a is None or b is None:
        return None
    if a == b:
        return True
    for x, y in ((a, b), (b, a)):
        if isinstance(x, int) and isinstance(y, str) and y.startswith("#"):
            return palette_rgb(x) == y
    return False
