/**
 * The terminal grid the daemon accepts, and the grid a pane asks it for.
 *
 * KEEP IN STEP WITH `daemon/src/session_ctl.rs` (`MIN_COLS`, `MAX_COLS`,
 * `MIN_ROWS`, `MAX_ROWS`). The daemon refuses any size outside these bounds —
 * a resize, a take_control, a focus_view, a history sized for the screen — and
 * a terminal whose size it refused was left drawing nothing at all: a pane
 * under about 175px wide or 100px tall stayed blank. The mobile app holds its
 * grid to the same bounds (`GRID_BOUNDS` in its terminal worker). The unit
 * test reads these from session_ctl.rs, so the two cannot drift apart.
 */
export const DAEMON_MIN_COLS = 20;
export const DAEMON_MAX_COLS = 400;
export const DAEMON_MIN_ROWS = 5;
export const DAEMON_MAX_ROWS = 200;

/**
 * What a pane of a given size asks the daemon for.
 *
 * - `fits`: the grid it fits, which every pane of 20 columns by 5 rows or more
 *   does — exactly the fit it has always had — held to the maximum past it.
 * - `too-small`: under the minimum in either dimension. It asks for nothing:
 *   no resize, no claim on the display. A pane squeezed by layout must not
 *   shrink a session that a phone, or an agent drawing a full-screen
 *   interface, is sized for; it shows the session at the size it already has,
 *   clipped, instead (see the terminal's clipped frame).
 * - `unmeasured`: no size could be read — not a number, or nothing at all. It
 *   is not sized, as FitAddon's own `fit()` would not size it either.
 */
export type PaneSizing =
  | { kind: "fits"; cols: number; rows: number }
  | { kind: "too-small" }
  | { kind: "unmeasured" };

export function paneSizing(fits: { cols: number; rows: number } | null | undefined): PaneSizing {
  if (!fits || !Number.isFinite(fits.cols) || !Number.isFinite(fits.rows)) {
    return { kind: "unmeasured" };
  }
  if (fits.cols <= 0 || fits.rows <= 0) return { kind: "unmeasured" };
  if (fits.cols < DAEMON_MIN_COLS || fits.rows < DAEMON_MIN_ROWS) return { kind: "too-small" };
  return {
    kind: "fits",
    cols: Math.min(DAEMON_MAX_COLS, Math.floor(fits.cols)),
    rows: Math.min(DAEMON_MAX_ROWS, Math.floor(fits.rows)),
  };
}
