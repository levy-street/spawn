"""Grid-state differ: cell-by-cell comparison of two schema-v1 documents.

Comparison semantics (see schema/schema.md):
- omitted cell fields are expanded to schema defaults before comparison;
- text is compared NFC-normalized;
- colors compare semantically (palette index >= 16 equals its canonical
  #rrggbb; indices 0-15 only equal themselves);
- any null (unobservable) field on either side is a wildcard: it never
  mismatches, but wildcard usage is counted and reported.
"""
from __future__ import annotations

import dataclasses
import pathlib
import sys
import typing

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "common"))
import gridstate  # noqa: E402

MAX_CELL_DIFFS_PER_CASE = 20


@dataclasses.dataclass
class Mismatch:
    where: str  # e.g. "cell r3c17", "cursor.col", "title"
    field: str
    expected: typing.Any
    actual: typing.Any

    def format(self) -> str:
        return f"{self.where}: {self.field} expected={_short(self.expected)} actual={_short(self.actual)}"


@dataclasses.dataclass
class CaseResult:
    case: str
    mismatches: list[Mismatch]
    cell_mismatch_count: int  # total, even beyond the reporting cap
    wildcards: int  # comparisons skipped because one side was null
    error: str | None = None

    @property
    def passed(self) -> bool:
        return self.error is None and not self.mismatches


def _short(value: typing.Any) -> str:
    text = repr(value)
    return text if len(text) <= 40 else text[:37] + "..."


def _scalar_equal(a: typing.Any, b: typing.Any) -> bool | None:
    """None = wildcard (either side null)."""
    if a is None or b is None:
        return None
    return a == b


def compare_states(expected: dict, actual: dict, case: str) -> CaseResult:
    mismatches: list[Mismatch] = []
    wildcards = 0
    cell_mismatch_count = 0

    if expected["version"] != actual["version"]:
        return CaseResult(
            case,
            [],
            0,
            0,
            error=f"schema version mismatch: expected doc v{expected['version']}, actual doc v{actual['version']}",
        )

    if expected["size"] != actual["size"]:
        return CaseResult(
            case,
            [Mismatch("size", "cols/rows", expected["size"], actual["size"])],
            0,
            0,
        )

    def check(where: str, field: str, exp: typing.Any, act: typing.Any) -> None:
        nonlocal wildcards
        result = _scalar_equal(exp, act)
        if result is None:
            wildcards += 1
        elif not result:
            mismatches.append(Mismatch(where, field, exp, act))

    check("cursor", "row", expected["cursor"]["row"], actual["cursor"]["row"])
    check("cursor", "col", expected["cursor"]["col"], actual["cursor"]["col"])
    check(
        "cursor",
        "visible",
        expected["cursor"].get("visible", True),
        actual["cursor"].get("visible", True),
    )
    check("screen", "altScreen", expected["altScreen"], actual["altScreen"])
    check("screen", "title", expected.get("title", ""), actual.get("title", ""))

    exp_rows = gridstate.expand_rows(expected)
    act_rows = gridstate.expand_rows(actual)
    cell_reports = 0
    for y, (exp_row, act_row) in enumerate(zip(exp_rows, act_rows)):
        for x, (exp_cell, act_cell) in enumerate(zip(exp_row, act_row)):
            diffs = _compare_cell(exp_cell, act_cell)
            if diffs is None:
                wildcards += 1
                continue
            if not diffs:
                continue
            cell_mismatch_count += 1
            if cell_reports < MAX_CELL_DIFFS_PER_CASE:
                cell_reports += 1
                for field, (exp_v, act_v) in diffs.items():
                    mismatches.append(Mismatch(f"cell r{y}c{x}", field, exp_v, act_v))

    return CaseResult(case, mismatches, cell_mismatch_count, wildcards)


def _compare_cell(exp: dict, act: dict) -> dict[str, tuple] | None:
    """Return {field: (expected, actual)} for mismatched fields.

    Returns None if the whole-cell comparison was wildcarded (should not
    happen in practice; individual null fields are simply skipped).
    """
    diffs: dict[str, tuple] = {}

    exp_text = gridstate.normalize_text(exp["text"])
    act_text = gridstate.normalize_text(act["text"])
    if exp_text != act_text:
        diffs["text"] = (exp["text"], act["text"])
    if exp["width"] != act["width"]:
        diffs["width"] = (exp["width"], act["width"])

    for channel in ("fg", "bg"):
        result = gridstate.colors_equal(exp[channel], act[channel])
        if result is False:
            diffs[channel] = (exp[channel], act[channel])

    for flag in gridstate.STYLE_FLAGS:
        result = _scalar_equal(exp[flag], act[flag])
        if result is False:
            diffs[flag] = (exp[flag], act[flag])

    return diffs


# --- report rendering --------------------------------------------------------


def render_report(
    results: list[CaseResult],
    expected_label: str,
    actual_label: str,
    known_divergences: dict[str, str] | None = None,
) -> tuple[str, int]:
    """Render a human-readable report.

    Exit-code convention:
      0 = every case passed, or every failing case is listed in known-divergences
      1 = at least one unexpected divergence (or a known-divergent case now passes,
          meaning the allowlist is stale)
      2 = comparison could not run (runner error, missing fixture, version skew)
    """
    known = known_divergences or {}
    lines: list[str] = []
    lines.append("term-conformance report")
    lines.append(f"  expected (oracle): {expected_label}")
    lines.append(f"  actual   (SUT)  : {actual_label}")
    lines.append("")

    passed = failed_known = failed_unexpected = errored = stale = 0
    for r in sorted(results, key=lambda r: r.case):
        if r.error is not None:
            errored += 1
            lines.append(f"ERROR {r.case}: {r.error}")
            continue
        if r.passed:
            if r.case in known:
                stale += 1
                lines.append(
                    f"PASS  {r.case} (STALE known-divergence entry: now passes — remove it)"
                )
            else:
                passed += 1
                note = f" [{r.wildcards} wildcard fields]" if r.wildcards else ""
                lines.append(f"PASS  {r.case}{note}")
            continue

        if r.case in known:
            failed_known += 1
            label = f"DIVERGES (known: {known[r.case]})"
        else:
            failed_unexpected += 1
            label = "FAIL"
        summary_bits = []
        if r.cell_mismatch_count:
            summary_bits.append(f"{r.cell_mismatch_count} cell(s)")
        non_cell = [m for m in r.mismatches if not m.where.startswith("cell ")]
        if non_cell:
            summary_bits.append(", ".join(sorted({m.where + "." + m.field for m in non_cell})))
        lines.append(f"{label.split(' ')[0]:5s} {r.case}: {label} — {'; '.join(summary_bits) or 'mismatch'}")
        for m in r.mismatches:
            lines.append(f"        {m.format()}")
        if r.cell_mismatch_count > MAX_CELL_DIFFS_PER_CASE:
            lines.append(
                f"        ... {r.cell_mismatch_count - MAX_CELL_DIFFS_PER_CASE} more mismatched cell(s) not shown"
            )

    lines.append("")
    lines.append(
        f"summary: {len(results)} cases — {passed} pass, {failed_known} known-divergent, "
        f"{failed_unexpected} unexpected fail, {stale} stale-known, {errored} error"
    )

    if errored:
        exit_code = 2
    elif failed_unexpected or stale:
        exit_code = 1
    else:
        exit_code = 0
    lines.append(f"exit code: {exit_code}")
    return "\n".join(lines) + "\n", exit_code
