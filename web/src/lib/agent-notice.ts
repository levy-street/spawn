/**
 * Notices an agent CLI paints into its own status bar, read back off the
 * terminal screen by the client that is showing it.
 *
 * This is deliberately a browser-side read of the rendered screen and not a
 * daemon-side scan of the byte stream: the daemon and server stay content-blind
 * (docs/TRUST.md), and the one place a "restart to update" line matters is in
 * front of the person looking at the pane that shows it.
 */

/** What is recognised: the agent installed a newer version of itself in the
 *  background and is still running the old one (`update_installed`); or a
 *  Codex refused `--no-daemon` as an unknown argument
 *  (`codex_no_daemon_refused`), which the launch that typed it answers by
 *  typing the command again without it (`usePendingLaunchDrain`). */
export type AgentNotice = "update_installed" | "codex_no_daemon_refused";

/**
 * Claude Code's status bar after a background self-update. Both spellings the
 * CLI ships are matched, and the separator is left loose: a narrow pane can
 * truncate the middle dot, and a screen reader row may drop it altogether.
 */
const CLAUDE_CODE_UPDATE_INSTALLED = /Update installed\s*\S?\s*Restart to (?:update|apply)/;

/**
 * Codex's refusal of the flag, the whole line as Codex 0.155.1 prints it at a
 * shell (clap's error, from column 0). Only that line counts: the same words
 * mid-line, indented, or inside Codex's own interface — a thread that talks
 * about this error — are not a refusal.
 */
export const CODEX_NO_DAEMON_REFUSAL = "error: unexpected argument '--no-daemon' found";

/** One terminal row: its text with nothing trimmed, and whether it
 *  continues the row above (the terminal wrapped a longer line). */
export interface ScreenRow {
  text: string;
  wrapped: boolean;
}

/**
 * The lines `rows` show, a wrapped row joined to the one it continues, so a
 * pane narrower than a line still shows it whole; each with trailing blanks
 * trimmed.
 */
export function screenLines(rows: readonly ScreenRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines.map((line) => line.trimEnd());
}

/**
 * What the live screen says, if anything. `lines` is the screen's lines, top
 * to bottom (`screenLines`) — the whole live screen, not just its bottom: an
 * agent's status bar sits wherever its UI ended up, which early in a session
 * on a tall pane is nowhere near the last row.
 */
export function detectAgentNotice(lines: readonly string[]): AgentNotice | null {
  for (const line of lines) {
    if (CLAUDE_CODE_UPDATE_INSTALLED.test(line)) return "update_installed";
  }
  for (const line of lines) {
    if (line.trimEnd() === CODEX_NO_DAEMON_REFUSAL) return "codex_no_daemon_refused";
  }
  return null;
}
