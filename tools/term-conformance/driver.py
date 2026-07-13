#!/usr/bin/env python3
"""term-conformance driver.

Subcommands:
  run-sut          replay corpus through @xterm/headless, write grid JSONs
  record-fixtures  replay corpus through an oracle (pyte locally, iterm2 on macOS)
  compare          diff two directories of grid JSONs, print/write a report
  full-run         record pyte fixtures + run SUT + compare (whole pipeline)

Exit codes (compare / full-run):
  0 = all cases pass, or every failure is listed in known-divergences.json
  1 = unexpected divergence, or a known-divergent case now passes (stale entry)
  2 = pipeline error (runner crashed, missing fixture, schema violation)

Examples:
  uv run driver.py full-run
  uv run driver.py run-sut --case wide-cjk
  uv run driver.py compare --expected fixtures-pyte --actual out/sut
  uv run driver.py record-fixtures --oracle iterm2        # macOS only
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "common"))
sys.path.insert(0, str(ROOT / "differ"))
sys.path.insert(0, str(ROOT / "oracle-pyte"))

import differ  # noqa: E402
import gridstate  # noqa: E402

MANIFEST = ROOT / "corpus" / "manifest.json"
KNOWN_DIVERGENCES = ROOT / "known-divergences.json"
SUT_DIR = ROOT / "sut-xterm"
DEFAULT_SUT_OUT = ROOT / "out" / "sut"
DEFAULT_PYTE_OUT = ROOT / "fixtures-pyte"
DEFAULT_ITERM2_OUT = ROOT / "fixtures"


def load_manifest(only_case: str | None = None) -> list[dict]:
    manifest = json.loads(MANIFEST.read_text())
    cases = manifest["cases"]
    if only_case is not None:
        cases = [c for c in cases if c["name"] == only_case]
        if not cases:
            sys.exit(f"error: case {only_case!r} not in corpus manifest")
    return cases


def load_equivalences() -> list[dict]:
    """Groups of cases whose final grids must be identical (e.g. the
    repaint-convergence pair modeling checkpoint-replay reattach)."""
    return json.loads(MANIFEST.read_text()).get("equivalences", [])


def load_known_divergences() -> dict[str, str]:
    if not KNOWN_DIVERGENCES.exists():
        return {}
    doc = json.loads(KNOWN_DIVERGENCES.read_text())
    return {entry["case"]: entry["reason"] for entry in doc["divergences"]}


def _ensure_sut_deps() -> None:
    if not (SUT_DIR / "node_modules" / "@xterm" / "headless").exists():
        print("installing sut-xterm npm dependencies...", file=sys.stderr)
        subprocess.run(
            ["npm", "install", "--no-audit", "--no-fund"], cwd=SUT_DIR, check=True
        )


def cmd_run_sut(args: argparse.Namespace) -> int:
    _ensure_sut_deps()
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    node = shutil.which("node")
    if node is None:
        sys.exit("error: node not found on PATH")

    for case in load_manifest(args.case):
        case_file = ROOT / "corpus" / case["file"]
        proc = subprocess.run(
            [
                node,
                str(SUT_DIR / "run.mjs"),
                str(case_file),
                "--cols",
                str(case["cols"]),
                "--rows",
                str(case["rows"]),
                "--name",
                case["name"],
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            print(proc.stderr, file=sys.stderr)
            sys.exit(f"error: SUT runner failed on case {case['name']}")
        state = json.loads(proc.stdout)
        gridstate.validate_state(state, source=f"sut:{case['name']}")
        (out_dir / f"{case['name']}.json").write_text(
            json.dumps(state, ensure_ascii=False) + "\n"
        )
        print(f"sut   {case['name']}")
    return 0


def cmd_record_fixtures(args: argparse.Namespace) -> int:
    if args.oracle == "pyte":
        import pyte_runner

        out_dir = pathlib.Path(args.out or DEFAULT_PYTE_OUT)
        out_dir.mkdir(parents=True, exist_ok=True)
        for case in load_manifest(args.case):
            data = (ROOT / "corpus" / case["file"]).read_bytes()
            state = pyte_runner.run_case(data, case["cols"], case["rows"], case["name"])
            gridstate.validate_state(state, source=f"pyte:{case['name']}")
            (out_dir / f"{case['name']}.json").write_text(
                json.dumps(state, ensure_ascii=False) + "\n"
            )
            print(f"pyte  {case['name']}")
        return 0

    if args.oracle == "iterm2":
        # The iterm2 runner drives a live iTerm2 app; it only works on macOS
        # with the Python API enabled. It records all cases over a single
        # WebSocket connection. See oracle-iterm2/README.md.
        out_dir = pathlib.Path(args.out or DEFAULT_ITERM2_OUT)
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            sys.executable,
            str(ROOT / "oracle-iterm2" / "iterm2_runner.py"),
            "--out",
            str(out_dir),
        ]
        if args.case:
            cmd += ["--case", args.case]
        return subprocess.run(cmd).returncode

    sys.exit(f"error: unknown oracle {args.oracle!r}")


def _load_states(directory: pathlib.Path, cases: list[dict]) -> dict[str, dict | str]:
    """case name -> parsed state, or an error string."""
    out: dict[str, dict | str] = {}
    for case in cases:
        path = directory / f"{case['name']}.json"
        if not path.exists():
            out[case["name"]] = f"missing {path}"
            continue
        try:
            state = json.loads(path.read_text())
            gridstate.validate_state(state, source=str(path))
            out[case["name"]] = state
        except (ValueError, json.JSONDecodeError) as exc:
            out[case["name"]] = str(exc)
    return out


def _compare_dirs(
    expected_dir: pathlib.Path,
    actual_dir: pathlib.Path,
    report_path: pathlib.Path | None,
    only_case: str | None,
) -> int:
    cases = load_manifest(only_case)
    expected = _load_states(expected_dir, cases)
    actual = _load_states(actual_dir, cases)

    results = []
    exp_label = act_label = None
    for case in cases:
        name = case["name"]
        exp, act = expected[name], actual[name]
        if isinstance(exp, str):
            results.append(differ.CaseResult(name, [], 0, 0, error=f"expected: {exp}"))
            continue
        if isinstance(act, str):
            results.append(differ.CaseResult(name, [], 0, 0, error=f"actual: {act}"))
            continue
        exp_label = exp_label or _producer_label(exp, expected_dir)
        act_label = act_label or _producer_label(act, actual_dir)
        results.append(differ.compare_states(exp, act, name))

    # Equivalence groups: every member of a group must produce an identical
    # grid within EACH side (oracle and SUT separately). Failures are ordinary
    # unexpected failures (exit 1) — the allowlist does not apply to them.
    if only_case is None:
        for group in load_equivalences():
            for side, states in (("oracle", expected), ("sut", actual)):
                members = [(n, states.get(n)) for n in group["cases"]]
                bad = [n for n, s in members if not isinstance(s, dict)]
                label = f"equiv:{group['name']}:{side}"
                if bad:
                    results.append(
                        differ.CaseResult(label, [], 0, 0, error=f"missing member(s): {bad}")
                    )
                    continue
                first_name, first_state = members[0]
                for other_name, other_state in members[1:]:
                    r = differ.compare_states(first_state, other_state, label)
                    if not r.passed:
                        r.mismatches.insert(
                            0,
                            differ.Mismatch(
                                "equivalence",
                                "grids",
                                f"{first_name} == {other_name}",
                                "grids differ",
                            ),
                        )
                    results.append(r)

    report, exit_code = differ.render_report(
        results,
        exp_label or str(expected_dir),
        act_label or str(actual_dir),
        load_known_divergences(),
    )
    print(report, end="")
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report)
        print(f"report written to {report_path}", file=sys.stderr)
    return exit_code


def _producer_label(state: dict, directory: pathlib.Path) -> str:
    producer = state.get("producer") or {}
    name = producer.get("name", "unknown")
    version = producer.get("version") or "?"
    try:
        shown = directory.resolve().relative_to(ROOT)
    except ValueError:
        shown = directory
    return f"{name} {version} ({shown})"


def cmd_compare(args: argparse.Namespace) -> int:
    return _compare_dirs(
        pathlib.Path(args.expected),
        pathlib.Path(args.actual),
        pathlib.Path(args.report) if args.report else None,
        args.case,
    )


def cmd_full_run(args: argparse.Namespace) -> int:
    if args.oracle != "pyte":
        sys.exit("error: full-run only supports --oracle pyte on this machine; "
                 "record iTerm2 fixtures on a Mac, then use `compare`.")
    record_args = argparse.Namespace(oracle="pyte", out=None, case=args.case)
    rc = cmd_record_fixtures(record_args)
    if rc != 0:
        return 2
    sut_args = argparse.Namespace(out=str(DEFAULT_SUT_OUT), case=args.case)
    if cmd_run_sut(sut_args) != 0:
        return 2
    return _compare_dirs(
        DEFAULT_PYTE_OUT,
        DEFAULT_SUT_OUT,
        pathlib.Path(args.report) if args.report else None,
        args.case,
    )


def cmd_perf(args: argparse.Namespace) -> int:
    """Throughput smoke: feed a large synthetic stream (not committed to the
    corpus) through the SUT and report parse/emulation throughput plus a
    final-grid sanity check. Report-only: exits 0 unless the SUT crashes or
    the final grid is wrong (2), so timing noise never breaks CI."""
    import tempfile
    import time

    _ensure_sut_deps()
    node = shutil.which("node")
    if node is None:
        sys.exit("error: node not found on PATH")

    lines = args.lines
    parts: list[str] = []
    for i in range(lines):
        color = 31 + (i % 7)
        parts.append(
            f"\x1b[{color}m{i:08d}\x1b[0m "
            + "col=\x1b[1m" + "x" * 48 + "\x1b[22m "
            + f"\x1b[38;5;{16 + (i % 216)}mZ\x1b[0m\r\n"
        )
    parts.append("\x1b[2K\x1b[35mPERF-END-MARKER\x1b[0m")
    payload = "".join(parts).encode()

    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
        tmp.write(payload)
        tmp_path = pathlib.Path(tmp.name)
    try:
        wall_start = time.monotonic()
        proc = subprocess.run(
            [node, str(SUT_DIR / "run.mjs"), str(tmp_path),
             "--cols", "80", "--rows", "24", "--name", "perf-smoke"],
            capture_output=True,
            text=True,
        )
        wall_s = time.monotonic() - wall_start
    finally:
        tmp_path.unlink(missing_ok=True)

    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        print("perf-smoke: SUT crashed", file=sys.stderr)
        return 2

    write_ms = None
    for token in proc.stderr.split():
        if token.startswith("sut-write-ms="):
            write_ms = float(token.split("=", 1)[1])

    state = json.loads(proc.stdout)
    gridstate.validate_state(state, source="perf-smoke")
    final_rows = ["".join(c.get("text", " ") for c in row) for row in state["rows"]]
    marker_ok = any("PERF-END-MARKER" in row for row in final_rows)
    last_line_ok = any(f"{lines - 1:08d}" in row for row in final_rows)

    mb = len(payload) / 1e6
    report_lines = [
        "term-conformance perf smoke (xterm-headless, web client config)",
        f"  payload: {lines} lines, {mb:.1f} MB (SGR 16/256-color + bold per line)",
        f"  wall time (node process): {wall_s:.2f} s",
    ]
    if write_ms is not None:
        report_lines.append(
            f"  emulation write time: {write_ms / 1000:.2f} s ({mb / (write_ms / 1000):.1f} MB/s)"
        )
    report_lines.append(
        f"  final grid: marker={'ok' if marker_ok else 'MISSING'} "
        f"last-line={'ok' if last_line_ok else 'MISSING'}"
    )
    report = "\n".join(report_lines) + "\n"
    print(report, end="")
    if args.report:
        path = pathlib.Path(args.report)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(report)
    return 0 if (marker_ok and last_line_ok) else 2


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="term-conformance",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("run-sut", help="run corpus through @xterm/headless")
    p.add_argument("--out", default=str(DEFAULT_SUT_OUT))
    p.add_argument("--case", default=None, help="run a single case")
    p.set_defaults(func=cmd_run_sut)

    p = sub.add_parser("record-fixtures", help="run corpus through an oracle")
    p.add_argument("--oracle", choices=["pyte", "iterm2"], required=True)
    p.add_argument("--out", default=None, help="fixtures-pyte/ or fixtures/ by default")
    p.add_argument("--case", default=None)
    p.set_defaults(func=cmd_record_fixtures)

    p = sub.add_parser("compare", help="diff two directories of grid JSONs")
    p.add_argument("--expected", required=True, help="oracle/fixtures directory")
    p.add_argument("--actual", required=True, help="SUT output directory")
    p.add_argument("--report", default=None, help="also write report to this file")
    p.add_argument("--case", default=None)
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("full-run", help="pyte fixtures + SUT + compare")
    p.add_argument("--oracle", default="pyte", choices=["pyte"])
    p.add_argument("--report", default=None)
    p.add_argument("--case", default=None)
    p.set_defaults(func=cmd_full_run)

    p = sub.add_parser("perf", help="throughput smoke: large synthetic stream through the SUT")
    p.add_argument("--lines", type=int, default=100_000, help="synthetic output lines")
    p.add_argument("--report", default=None, help="also write the timing report to this file")
    p.set_defaults(func=cmd_perf)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
