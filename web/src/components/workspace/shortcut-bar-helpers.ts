import type { Session } from "@/lib/api";
import { isShellCommand } from "@/lib/sessions";

export interface CursorCellRect {
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
}

export interface ShortcutPosition {
  left: number;
  top: number;
  maxWidth: number;
  flipped: boolean;
}

export function shortcutBarVisible(
  session: Pick<Session, "status" | "foreground_command">,
  promptState: "empty" | "typing",
): boolean {
  const atShell = session.foreground_command === null || isShellCommand(session.foreground_command);
  return session.status === "running" && atShell && promptState === "empty";
}

/** Position a cursor popup inside its terminal pane, with an 8px edge inset. */
export function shortcutBarPosition(
  cursor: CursorCellRect,
  paneWidth: number,
  paneHeight: number,
  popupWidth: number,
  popupHeight: number,
): ShortcutPosition {
  const inset = 8;
  const maxWidth = Math.max(0, paneWidth - inset * 2);
  const width = Math.min(Math.max(0, popupWidth), maxWidth);
  const left = Math.min(Math.max(inset, cursor.left), Math.max(inset, paneWidth - width - inset));
  const below = cursor.top + cursor.cellHeight + 4;
  const flipped = below + popupHeight > paneHeight - inset;
  const top = flipped ? Math.max(inset, cursor.top - popupHeight - 4) : Math.max(inset, below);
  return { left, top, maxWidth, flipped };
}
