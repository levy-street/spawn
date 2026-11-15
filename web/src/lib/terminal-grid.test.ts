import { describe, expect, test } from "bun:test";
import {
  DAEMON_MAX_COLS,
  DAEMON_MAX_ROWS,
  DAEMON_MIN_COLS,
  DAEMON_MIN_ROWS,
  daemonGrid,
} from "./terminal-grid";

describe("the daemon's grid bounds", () => {
  test("are the ones daemon/src/session_ctl.rs validates against", () => {
    // MIN_COLS, MAX_COLS, MIN_ROWS, MAX_ROWS there. A size outside them is
    // refused — resize, take_control, focus_view and a sized history alike.
    expect([DAEMON_MIN_COLS, DAEMON_MAX_COLS, DAEMON_MIN_ROWS, DAEMON_MAX_ROWS]).toEqual([
      20, 400, 5, 200,
    ]);
  });
});

describe("daemonGrid", () => {
  test("a pane inside the bounds gets exactly the grid it fits, unclipped", () => {
    expect(daemonGrid({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24, clipped: false });
  });

  test("at the minimum in both dimensions is still a fit, not a clip", () => {
    expect(daemonGrid({ cols: 20, rows: 5 })).toEqual({ cols: 20, rows: 5, clipped: false });
  });

  test("too narrow keeps the minimum columns and clips them", () => {
    expect(daemonGrid({ cols: 19, rows: 24 })).toEqual({ cols: 20, rows: 24, clipped: true });
    expect(daemonGrid({ cols: 2, rows: 24 })).toEqual({ cols: 20, rows: 24, clipped: true });
  });

  test("too short keeps the minimum rows and clips them", () => {
    expect(daemonGrid({ cols: 80, rows: 4 })).toEqual({ cols: 80, rows: 5, clipped: true });
    expect(daemonGrid({ cols: 80, rows: 1 })).toEqual({ cols: 80, rows: 5, clipped: true });
  });

  test("too small both ways is the minimum grid", () => {
    expect(daemonGrid({ cols: 11, rows: 3 })).toEqual({ cols: 20, rows: 5, clipped: true });
  });

  test("a pane past the maximum is held to it, with nothing to clip", () => {
    expect(daemonGrid({ cols: 450, rows: 230 })).toEqual({ cols: 400, rows: 200, clipped: false });
  });

  test("a pane that cannot be measured asks for the minimum", () => {
    expect(daemonGrid({ cols: Number.NaN, rows: Number.POSITIVE_INFINITY })).toEqual({
      cols: 20,
      rows: 5,
      clipped: true,
    });
  });

  test("a pane hovering around the threshold does not flap the grid it asks for", () => {
    // The pane shrinks and grows by a column or a row at a time across the
    // minimum: every size at or under it asks for the same grid, so there is
    // nothing new to send until it is really past it again.
    const asked = [21, 20, 19, 18, 19, 20, 19, 21].map(
      (cols) => daemonGrid({ cols, rows: 24 }).cols,
    );
    expect(asked).toEqual([21, 20, 20, 20, 20, 20, 20, 21]);
    const changes = asked.filter((cols, index) => index > 0 && cols !== asked[index - 1]);
    expect(changes).toEqual([20, 21]);
    const rows = [6, 5, 4, 3, 4, 5, 4, 6].map((r) => daemonGrid({ cols: 80, rows: r }).rows);
    expect(rows).toEqual([6, 5, 5, 5, 5, 5, 5, 6]);
  });

  test("a clipped pane changing size under the minimum asks for nothing new", () => {
    // Only the clipped viewport moved: the grid, and so the daemon, stay put.
    const sizes = [15, 12, 17, 9].map((cols) => daemonGrid({ cols, rows: 3 }));
    expect(new Set(sizes.map(({ cols, rows }) => `${cols}x${rows}`))).toEqual(new Set(["20x5"]));
  });
});
