/**
 * The terminal grid the daemon accepts, and the grid a pane asks it for.
 *
 * KEEP IN STEP WITH `daemon/src/session_ctl.rs` (`MIN_COLS`, `MAX_COLS`,
 * `MIN_ROWS`, `MAX_ROWS`). The daemon refuses any size outside these bounds —
 * a resize, a take_control, a focus_view, a history sized for the screen — and
 * a terminal whose size it refused was left drawing nothing at all: a pane
 * under about 175px wide or 100px tall stayed blank. The mobile app holds its
 * grid to the same bounds (`GRID_BOUNDS` in its terminal worker).
 */
export const DAEMON_MIN_COLS = 20;
export const DAEMON_MAX_COLS = 400;
export const DAEMON_MIN_ROWS = 5;
export const DAEMON_MAX_ROWS = 200;

export interface TerminalGrid {
  cols: number;
  rows: number;
  /**
   * The grid is bigger than the pane in some dimension: the pane shows what
   * fits of it, clipped, rather than asking for a size the daemon refuses.
   */
  clipped: boolean;
}

function within(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.floor(value)));
}

/**
 * The grid a pane that fits `fits` asks the daemon for: exactly that, when it
 * is inside the bounds — which every pane bigger than 20 columns by 5 rows
 * is, so they behave exactly as they always have — or held to the nearest
 * bound when it is not.
 *
 * Under the minimum the grid stays at the minimum and the pane clips it. That
 * is also what keeps a pane hovering at the threshold quiet: every size at or
 * under the minimum asks for the same grid, so nothing new reaches the daemon
 * until the pane is past it again, and a clipped pane that only changes how
 * much of the grid it shows asks for nothing at all. Past the maximum the grid
 * is simply held to it; the pane has room to spare, so nothing is clipped.
 */
export function daemonGrid(fits: { cols: number; rows: number }): TerminalGrid {
  const cols = within(fits.cols, DAEMON_MIN_COLS, DAEMON_MAX_COLS);
  const rows = within(fits.rows, DAEMON_MIN_ROWS, DAEMON_MAX_ROWS);
  const narrow = !Number.isFinite(fits.cols) || fits.cols < DAEMON_MIN_COLS;
  const short = !Number.isFinite(fits.rows) || fits.rows < DAEMON_MIN_ROWS;
  return { cols, rows, clipped: narrow || short };
}
