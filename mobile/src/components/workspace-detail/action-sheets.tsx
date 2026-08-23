import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { canMovePaneToTab, canRemoveTab } from "@/data/layout/tabs";
import { canAddTile, orderedTiles } from "@/data/layout/tiles";
import { sessionTitle } from "@/data/selectors/session";
import type { AgentDef, Host, Session, Workspace } from "@/data/types/domain";
import { isFilesWidget, type Tile, type WorkspaceTab } from "@/data/types/layout";

export interface PaneActionTarget {
  tabId: string;
  tile: Tile;
}

export interface PaneActionsSheetProps {
  visible: boolean;
  target: PaneActionTarget | null;
  workspace: Workspace;
  sessionsById: ReadonlyMap<string, Session>;
  agents: readonly AgentDef[];
  onDismiss: () => void;
  onRename: (session: Session) => void;
  onMove: (tile: Tile) => void;
  /** Re-point this window at another machine (sessions only — a widget has none). */
  onMoveToHost: (tile: Tile, session: Session) => void;
  onDuplicate: (tile: Tile, session: Session | null) => void;
  onReorder: (target: PaneActionTarget, offset: -1 | 1) => void;
  onRestart: (session: Session) => void;
  onRemove: (tile: Tile) => void;
}

export function PaneActionsSheet({
  visible,
  target,
  workspace,
  sessionsById,
  agents,
  onDismiss,
  onRename,
  onMove,
  onMoveToHost,
  onDuplicate,
  onReorder,
  onRestart,
  onRemove,
}: PaneActionsSheetProps) {
  const tab = workspace.layout.tabs.find((candidate) => candidate.id === target?.tabId) ?? null;
  const tile = target?.tile ?? null;
  const session = tile && !tile.widget ? (sessionsById.get(tile.session_id) ?? null) : null;
  const index =
    tab && tile
      ? orderedTiles(tab.layout.tiles).findIndex((item) => item.session_id === tile.session_id)
      : -1;
  const canMove = tile
    ? workspace.layout.tabs.some((candidate) =>
        canMovePaneToTab(workspace.layout, tile.session_id, candidate.id),
      )
    : false;
  const actions: ActionSheetAction[] = [];

  if (session) {
    actions.push({
      id: "rename",
      label: "Rename",
      icon: <Icon name="Pencil" />,
      onPress: () => onRename(session),
    });
  }
  if (tile) {
    actions.push(
      {
        id: "move",
        label: "Move to another tab",
        icon: <Icon name="ArrowRightLeft" />,
        disabled: !canMove,
        ...(canMove ? {} : { detail: "No other tab has room" }),
        onPress: () => onMove(tile),
      },
      {
        id: "duplicate",
        label: "Duplicate",
        icon: <Icon name="Copy" />,
        disabled: tab ? !canAddTile(tab.layout) : true,
        ...(tab && !canAddTile(tab.layout) ? { detail: "This tab is full" } : {}),
        onPress: () => onDuplicate(tile, session),
      },
      {
        id: "move-up",
        label: "Move up",
        icon: <Icon name="ArrowUp" />,
        disabled: !target || index <= 0,
        ...(!target || index <= 0 ? { detail: "Already first" } : {}),
        onPress: () => {
          if (target) onReorder(target, -1);
        },
      },
      {
        id: "move-down",
        label: "Move down",
        icon: <Icon name="ArrowDown" />,
        disabled: !target || !tab || index < 0 || index >= tab.layout.tiles.length - 1,
        ...(!target || !tab || index < 0 || index >= tab.layout.tiles.length - 1
          ? { detail: "Already last" }
          : {}),
        onPress: () => {
          if (target) onReorder(target, 1);
        },
      },
    );
  }
  if (session && tile) {
    actions.push({
      id: "move-host",
      label: "Run on another host",
      detail: `Now on ${session.host_name ?? "this host"}`,
      icon: <Icon name="Server" />,
      onPress: () => onMoveToHost(tile, session),
    });
  }
  if (session) {
    actions.push({
      id: "restart",
      label: "Restart",
      detail: "Restart the login shell",
      icon: <Icon name="RotateCw" />,
      onPress: () => onRestart(session),
    });
  }
  if (tile) {
    actions.push({
      id: "remove",
      label: session ? "Close session" : "Remove pane",
      icon: <Icon color="destructive" name="Trash2" />,
      destructive: true,
      onPress: () => onRemove(tile),
    });
  }

  const title = session
    ? sessionTitle(session, agents)
    : tile && isFilesWidget(tile.widget)
      ? "Files"
      : "Pane actions";
  return (
    <ActionSheet
      actions={actions}
      onDismiss={onDismiss}
      title={title}
      visible={visible && target !== null}
    />
  );
}

export interface MovePaneSheetProps {
  visible: boolean;
  tile: Tile | null;
  workspace: Workspace;
  onDismiss: () => void;
  onMove: (tabId: string) => void;
}

export function MovePaneSheet({ visible, tile, workspace, onDismiss, onMove }: MovePaneSheetProps) {
  const sourceTabId = tile
    ? (workspace.layout.tabs.find((tab) =>
        tab.layout.tiles.some((candidate) => candidate.session_id === tile.session_id),
      )?.id ?? null)
    : null;
  const actions = tile
    ? workspace.layout.tabs.map((tab): ActionSheetAction => {
        const canMove = canMovePaneToTab(workspace.layout, tile.session_id, tab.id);
        return {
          id: tab.id,
          label: tab.name,
          disabled: !canMove,
          ...(canMove
            ? {}
            : { detail: tab.id === sourceTabId ? "Current tab" : "This tab is full" }),
          onPress: () => onMove(tab.id),
        };
      })
    : [];
  return (
    <ActionSheet
      actions={actions}
      message="Choose a destination tab."
      onDismiss={onDismiss}
      title="Move pane"
      visible={visible && tile !== null}
    />
  );
}

export interface MovePaneHostSheetProps {
  visible: boolean;
  session: Session | null;
  hosts: readonly Host[];
  onDismiss: () => void;
  onSelect: (host: Host) => void;
}

/**
 * Which machine a window runs on. Its shell cannot follow it across, so the
 * choice is destructive — the caller confirms before acting on it.
 */
export function MovePaneHostSheet({
  visible,
  session,
  hosts,
  onDismiss,
  onSelect,
}: MovePaneHostSheetProps) {
  const ordered = [...hosts].sort(
    (left, right) =>
      Number(right.status === "online") - Number(left.status === "online") ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const actions = ordered.map((host): ActionSheetAction => {
    const current = host.id === session?.host_id;
    const online = host.status === "online";
    return {
      id: host.id,
      label: host.name,
      icon: <StatusDot pulse={false} tone={online ? "active" : "offline"} />,
      selected: current,
      disabled: current || !online,
      accessibilityRole: "radio",
      ...(current ? { detail: "Already here" } : online ? {} : { detail: "Offline" }),
      onPress: () => onSelect(host),
    };
  });

  return (
    <ActionSheet
      actions={actions}
      message="The window keeps its place; a fresh shell starts in your home folder there."
      onDismiss={onDismiss}
      title="Run on another host"
      visible={visible && session !== null}
    />
  );
}

export interface TabActionsSheetProps {
  visible: boolean;
  tab: WorkspaceTab | null;
  workspace: Workspace;
  onDismiss: () => void;
  onRename: (tab: WorkspaceTab) => void;
  onReorder: (tab: WorkspaceTab, offset: -1 | 1) => void;
  onDelete: (tab: WorkspaceTab) => void;
}

export function TabActionsSheet({
  visible,
  tab,
  workspace,
  onDismiss,
  onRename,
  onReorder,
  onDelete,
}: TabActionsSheetProps) {
  const index = tab ? workspace.layout.tabs.findIndex((candidate) => candidate.id === tab.id) : -1;
  const actions: ActionSheetAction[] = tab
    ? [
        {
          id: "rename",
          label: "Rename tab",
          icon: <Icon name="Pencil" />,
          onPress: () => onRename(tab),
        },
        {
          id: "move-left",
          label: "Move left",
          icon: <Icon name="ArrowLeft" />,
          disabled: index <= 0,
          ...(index <= 0 ? { detail: "Already first" } : {}),
          onPress: () => onReorder(tab, -1),
        },
        {
          id: "move-right",
          label: "Move right",
          icon: <Icon name="ArrowRight" />,
          disabled: index < 0 || index >= workspace.layout.tabs.length - 1,
          ...(index < 0 || index >= workspace.layout.tabs.length - 1
            ? { detail: "Already last" }
            : {}),
          onPress: () => onReorder(tab, 1),
        },
        {
          id: "delete",
          label: "Close tab",
          detail:
            workspace.layout.tabs.length === 1
              ? "A workspace must keep one tab"
              : "Closes every session in this tab",
          icon: <Icon color="destructive" name="Trash2" />,
          destructive: true,
          disabled: !canRemoveTab(workspace.layout, tab.id),
          onPress: () => onDelete(tab),
        },
      ]
    : [];

  return (
    <ActionSheet
      actions={actions}
      onDismiss={onDismiss}
      visible={visible && tab !== null}
      {...(tab === null ? {} : { title: tab.name })}
    />
  );
}

export interface WorkspaceActionsSheetProps {
  visible: boolean;
  workspace: Workspace;
  canAddTab: boolean;
  onDismiss: () => void;
  onRename: () => void;
  onAddTab: () => void;
}

export function WorkspaceActionsSheet({
  visible,
  workspace,
  canAddTab,
  onDismiss,
  onRename,
  onAddTab,
}: WorkspaceActionsSheetProps) {
  return (
    <ActionSheet
      actions={[
        {
          id: "rename",
          label: "Rename workspace",
          icon: <Icon name="Pencil" />,
          onPress: onRename,
        },
        {
          id: "add-tab",
          label: "Add tab",
          icon: <Icon name="Plus" />,
          disabled: !canAddTab,
          ...(canAddTab ? {} : { detail: "A workspace can have up to 8 tabs" }),
          onPress: onAddTab,
        },
      ]}
      onDismiss={onDismiss}
      title={workspace.name}
      visible={visible}
    />
  );
}
