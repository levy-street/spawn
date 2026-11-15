import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DAEMON_MAX_COLS,
  DAEMON_MAX_ROWS,
  DAEMON_MIN_COLS,
  DAEMON_MIN_ROWS,
  paneSizing,
} from "./terminal-grid";

describe("the daemon's grid bounds", () => {
  test("are read from daemon/src/session_ctl.rs, so the two cannot drift apart", () => {
    // MIN_COLS, MAX_COLS, MIN_ROWS, MAX_ROWS there. A size outside them is
    // refused — resize, take_control, focus_view and a sized history alike.
    const source = readFileSync(
      new URL("../../../daemon/src/session_ctl.rs", import.meta.url),
      "utf8",
    );
    const bound = (name: string) => {
      const match = new RegExp(`pub const ${name}: u16 = (\\d+);`).exec(source);
      if (!match?.[1]) throw new Error(`${name} not found in session_ctl.rs`);
      return Number(match[1]);
    };
    expect({
      minCols: DAEMON_MIN_COLS,
      maxCols: DAEMON_MAX_COLS,
      minRows: DAEMON_MIN_ROWS,
      maxRows: DAEMON_MAX_ROWS,
    }).toEqual({
      minCols: bound("MIN_COLS"),
      maxCols: bound("MAX_COLS"),
      minRows: bound("MIN_ROWS"),
      maxRows: bound("MAX_ROWS"),
    });
  });
});

describe("paneSizing", () => {
  test("a pane inside the bounds fits exactly as it always has", () => {
    expect(paneSizing({ cols: 80, rows: 24 })).toEqual({ kind: "fits", cols: 80, rows: 24 });
  });

  test("at the minimum in both dimensions still fits", () => {
    expect(paneSizing({ cols: 20, rows: 5 })).toEqual({ kind: "fits", cols: 20, rows: 5 });
  });

  test("under the minimum in either dimension is too small: no size of its own at all", () => {
    // Not 20x5: a pane squeezed by layout must not shrink a session someone
    // else — a phone, an agent's full-screen UI — is sized for.
    expect(paneSizing({ cols: 19, rows: 24 })).toEqual({ kind: "too-small" });
    expect(paneSizing({ cols: 80, rows: 4 })).toEqual({ kind: "too-small" });
    expect(paneSizing({ cols: 11, rows: 3 })).toEqual({ kind: "too-small" });
    expect(paneSizing({ cols: 2, rows: 1 })).toEqual({ kind: "too-small" });
  });

  test("past the maximum is held to it", () => {
    expect(paneSizing({ cols: 450, rows: 24 })).toEqual({ kind: "fits", cols: 400, rows: 24 });
    expect(paneSizing({ cols: 80, rows: 230 })).toEqual({ kind: "fits", cols: 80, rows: 200 });
  });

  test("a pane that cannot be measured is not sized at all", () => {
    // FitAddon's own fit() ignores NaN; so does this, rather than guessing.
    expect(paneSizing({ cols: Number.NaN, rows: 24 })).toEqual({ kind: "unmeasured" });
    expect(paneSizing({ cols: 80, rows: Number.POSITIVE_INFINITY })).toEqual({
      kind: "unmeasured",
    });
    expect(paneSizing(undefined)).toEqual({ kind: "unmeasured" });
    expect(paneSizing({ cols: 0, rows: 0 })).toEqual({ kind: "unmeasured" });
  });

  test("a pane hovering around the threshold asks for nothing until it fits again", () => {
    // Every size under the minimum is the same answer — send nothing — so a
    // pane wobbling across it sends only the sizes at or above it.
    const sent = [21, 20, 19, 18, 19, 20, 19, 21]
      .map((cols) => paneSizing({ cols, rows: 24 }))
      .flatMap((sizing) => (sizing.kind === "fits" ? [sizing.cols] : []));
    expect(sent).toEqual([21, 20, 20, 21]);
  });
});
