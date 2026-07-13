"""iTerm2 reference oracle: record grid-state fixtures for the whole corpus.

============================================================================
STATUS: REVIEWED BUT UNEXECUTED.

This machine is Linux; the `iterm2` package only talks to a live iTerm2 app
on macOS, so this code has been written against the iTerm2 Python API source
(api/library/python/iterm2 @ master) and reviewed, but never run. Expect to
shake out small issues on first execution on a Mac. See README.md in this
directory for setup instructions.
============================================================================

Design: one WebSocket connection; for each corpus case, open a fresh window
whose session runs an inert command (`sleep`) so no shell output pollutes the
grid, resize the grid, `async_inject()` the case bytes (they are processed as
terminal output, bypassing the child process), poll `async_get_screen_contents()`
until two consecutive snapshots are identical, serialize to grid-state v1,
and close the window.

Fields the iTerm2 API cannot observe are emitted as null (differ wildcards):
- cursor.visible (DECTCEM state is not exposed),
- altScreen (best-effort via the `showingAlternateScreen` session variable,
  null if the variable is unavailable in the running iTerm2 version).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
import unicodedata

import iterm2

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "common"))
import gridstate  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETTLE_POLL_SECONDS = 0.15
SETTLE_TIMEOUT_SECONDS = 10.0


def _wcwidth(text: str) -> int:
    if not text:
        return 0
    return 2 if unicodedata.east_asian_width(text[0]) in ("W", "F") else 1


def _color(color: "iterm2.CellStyle.Color | None") -> gridstate.Color:
    if color is None:
        return "default"
    if color.is_standard:
        return color.standard
    if color.is_rgb:
        rgb = color.rgb
        return f"#{rgb.red:02x}{rgb.green:02x}{rgb.blue:02x}"
    if color.is_alternate:
        # DEFAULT / REVERSED_DEFAULT both render with the default color pair;
        # inverse is carried separately by the style's `inverse` bit.
        if color.alternate in (
            iterm2.CellStyle.AlternateColor.DEFAULT,
            iterm2.CellStyle.AlternateColor.REVERSED_DEFAULT,
        ):
            return "default"
    return None  # unobservable / system-message color: wildcard


def _serialize_contents(
    contents: "iterm2.ScreenContents",
    cols: int,
    rows: int,
    case: str,
    title: str | None,
    alt_screen: bool | None,
    producer_version: str | None,
) -> dict:
    grid: list[list[dict]] = []
    for y in range(rows):
        row: list[dict] = []
        line = contents.line(y) if y < contents.number_of_lines else None
        prev_was_wide = False
        for x in range(cols):
            text = line.string_at(x) if line is not None else ""
            style = line.style_at(x) if line is not None else None

            if text == "" and prev_was_wide:
                width = 0
                prev_was_wide = False
            else:
                width = _wcwidth(text) if text else 1
                prev_was_wide = width == 2
                if text == "":
                    text = " "  # uninitialized/erased cell

            cell: dict = {"text": text, "width": width}
            if style is None:
                # Uninitialized cell: schema defaults.
                cell.update(fg="default", bg="default")
                for flag in gridstate.STYLE_FLAGS:
                    cell[flag] = False
            else:
                cell["fg"] = _color(style.fg_color)
                cell["bg"] = _color(style.bg_color)
                cell["bold"] = bool(style.bold)
                cell["dim"] = bool(style.faint)
                cell["italic"] = bool(style.italic)
                cell["underline"] = bool(style.underline)
                cell["inverse"] = bool(style.inverse)
                cell["strikethrough"] = bool(style.strikethrough)
                cell["blink"] = bool(style.blink)
            row.append(cell)
        grid.append(row)

    cursor = contents.cursor_coord
    cursor_row = cursor.y - contents.number_of_lines_above_screen

    return gridstate.make_state(
        producer_name="iterm2",
        producer_version=producer_version,
        case=case,
        cols=cols,
        rows=rows,
        cursor_row=cursor_row,
        cursor_col=cursor.x,
        cursor_visible=None,  # DECTCEM state is not exposed by the API
        alt_screen=alt_screen,
        title=title,
        grid=grid,
    )


async def _wait_for_grid_size(session, cols: int, rows: int) -> None:
    deadline = asyncio.get_event_loop().time() + SETTLE_TIMEOUT_SECONDS
    while asyncio.get_event_loop().time() < deadline:
        size = session.grid_size
        if size is not None and size.width == cols and size.height == rows:
            return
        await asyncio.sleep(SETTLE_POLL_SECONDS)
    raise TimeoutError(f"session never reached {cols}x{rows}")


async def _settle_contents(session) -> "iterm2.ScreenContents":
    """Poll until two consecutive snapshots are identical (or timeout)."""
    deadline = asyncio.get_event_loop().time() + SETTLE_TIMEOUT_SECONDS
    previous = None
    contents = await session.async_get_screen_contents()
    while asyncio.get_event_loop().time() < deadline:
        snapshot = [
            contents.line(i).string for i in range(contents.number_of_lines)
        ] + [contents.cursor_coord.x, contents.cursor_coord.y]
        if snapshot == previous:
            return contents
        previous = snapshot
        await asyncio.sleep(SETTLE_POLL_SECONDS)
        contents = await session.async_get_screen_contents()
    return contents


async def record_case(connection, case: dict, out_dir: pathlib.Path, version: str | None) -> None:
    profile = iterm2.LocalWriteOnlyProfile()
    profile.set_use_custom_command("Yes")
    # Inert child process: injected bytes bypass it, and it never writes to
    # the tty, so the grid contains exactly the corpus case's effects.
    profile.set_command("/bin/sleep 100000")
    profile.set_scrollback_lines(1000)

    window = await iterm2.Window.async_create(
        connection, profile_customizations=profile
    )
    try:
        session = window.current_tab.current_session
        await session.async_set_grid_size(
            iterm2.util.Size(case["cols"], case["rows"])
        )
        await _wait_for_grid_size(session, case["cols"], case["rows"])

        data = (ROOT / "corpus" / case["file"]).read_bytes()
        await session.async_inject(data)
        contents = await _settle_contents(session)

        title = await session.async_get_variable("terminalWindowName")
        if not isinstance(title, str):
            title = ""  # OSC 0/2 never ran; iTerm2 reports no explicit title

        alt_screen: bool | None
        try:
            value = await session.async_get_variable("showingAlternateScreen")
            alt_screen = bool(value) if value is not None else None
        except Exception:  # variable not defined in this iTerm2 version
            alt_screen = None

        state = _serialize_contents(
            contents,
            case["cols"],
            case["rows"],
            case["name"],
            title,
            alt_screen,
            version,
        )
        gridstate.validate_state(state, source=f"iterm2:{case['name']}")
        out_path = out_dir / f"{case['name']}.json"
        out_path.write_text(json.dumps(state, ensure_ascii=False) + "\n")
        print(f"iterm2 {case['name']} -> {out_path}")
    finally:
        await window.async_close(force=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "fixtures"))
    parser.add_argument("--case", default=None, help="record a single case")
    args = parser.parse_args()

    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((ROOT / "corpus" / "manifest.json").read_text())
    cases = manifest["cases"]
    if args.case:
        cases = [c for c in cases if c["name"] == args.case]
        if not cases:
            sys.exit(f"error: case {args.case!r} not in manifest")

    try:
        from importlib.metadata import version as pkg_version

        iterm2_version = pkg_version("iterm2")
    except Exception:
        iterm2_version = None

    async def run(connection):
        for case in cases:
            await record_case(connection, case, out_dir, iterm2_version)
        print(f"recorded {len(cases)} fixtures to {out_dir}")

    iterm2.run_until_complete(run)


if __name__ == "__main__":
    main()
