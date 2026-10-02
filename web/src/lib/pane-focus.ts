/**
 * The pane last focused in each workspace, for surfaces outside the grid that
 * need to know it — the "add a window" menus suggest opening next to it. The
 * grid owns focus; this only mirrors what it last reported.
 */
const focused = new Map<string, string | null>();

export function recordPaneFocus(workspaceId: string, sessionId: string | null): void {
  focused.set(workspaceId, sessionId);
}

export function focusedPane(workspaceId: string | null | undefined): string | null {
  return workspaceId ? (focused.get(workspaceId) ?? null) : null;
}
