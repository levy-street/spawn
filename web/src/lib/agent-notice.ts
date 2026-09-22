/**
 * Notices an agent CLI paints into its own status bar, read back off the
 * terminal screen by the client that is showing it.
 *
 * This is deliberately a browser-side read of the rendered screen and not a
 * daemon-side scan of the byte stream: the daemon and server stay content-blind
 * (docs/TRUST.md), and the one place a "restart to update" line matters is in
 * front of the person looking at the pane that shows it.
 */

/** The one notice recognised so far: the agent installed a newer version of
 *  itself in the background and is still running the old one. */
export type AgentNotice = "update_installed";

/**
 * Claude Code's status bar after a background self-update. Both spellings the
 * CLI ships are matched, and the separator is left loose: a narrow pane can
 * truncate the middle dot, and a screen reader row may drop it altogether.
 */
const CLAUDE_CODE_UPDATE_INSTALLED = /Update installed\s*\S?\s*Restart to (?:update|apply)/;

/**
 * What the live screen says, if anything. `rows` is the text of the screen's
 * rows, top to bottom, as the terminal renders them — the whole live screen,
 * not just its bottom: an agent's status bar sits wherever its UI ended up,
 * which early in a session on a tall pane is nowhere near the last row.
 */
export function detectAgentNotice(rows: readonly string[]): AgentNotice | null {
  for (const row of rows) {
    if (CLAUDE_CODE_UPDATE_INSTALLED.test(row)) return "update_installed";
  }
  return null;
}
