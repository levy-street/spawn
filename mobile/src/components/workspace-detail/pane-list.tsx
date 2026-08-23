import { FlashList } from "@shopify/flash-list";
import { memo, useCallback, useMemo } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { DraggablePane } from "@/components/workspace-detail/draggable-pane";
import { FilesWidgetRow } from "@/components/workspace-detail/files-widget-row";
import type { PaneDragValues, PaneGhost } from "@/components/workspace-detail/pane-drag";
import { TerminalRow } from "@/components/workspace-detail/terminal-row";
import { readingOrder } from "@/data/layout/mobile-order";
import { identifyAgent } from "@/data/selectors/agent";
import { sessionTitle } from "@/data/selectors/session";
import type { AgentDef, Host, Session, TransportState } from "@/data/types/domain";
import { isFilesWidget, type Tile, type WorkspaceTab } from "@/data/types/layout";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface PaneListProps {
  tab: WorkspaceTab;
  sessionsById: ReadonlyMap<string, Session>;
  hostsById: ReadonlyMap<string, Host>;
  agents: readonly AgentDef[];
  transports: Readonly<Record<string, TransportState>>;
  canAddPane: boolean;
  onAddPane: () => void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenFiles: (hostId: string, path: string) => void;
  onPaneActions: (tile: Tile) => void;
  /** True only while a pull is being served, never for background polling. */
  refreshing: boolean;
  onRefresh: () => void;
  /** Absent when panes cannot be carried — a workspace with a single tab. */
  paneDrag?: PaneDragValues;
  /** The pane currently being carried, so its row can stay behind as a shadow. */
  draggingPaneId?: string | null;
  onPaneDragBegin?: (tile: Tile, ghost: PaneGhost) => void;
  /** The tab index the pane was released over, or -1 for nowhere. */
  onPaneDragEnd?: (tabIndex: number) => void;
}

export const PaneList = memo(function PaneList({
  tab,
  sessionsById,
  hostsById,
  agents,
  transports,
  canAddPane,
  onAddPane,
  onOpenTerminal,
  onOpenFiles,
  onPaneActions,
  refreshing,
  onRefresh,
  paneDrag,
  draggingPaneId = null,
  onPaneDragBegin,
  onPaneDragEnd,
}: PaneListProps) {
  const theme = useTheme();
  const tiles = useMemo(() => readingOrder(tab), [tab]);

  const renderItem = useCallback(
    ({ item: tile }: { item: Tile }) => {
      const widget = tile.widget;
      const session = widget ? null : (sessionsById.get(tile.session_id) ?? null);
      const row = isFilesWidget(widget) ? (
        <FilesWidgetRow
          hostName={hostsById.get(widget.host_id)?.name ?? null}
          hostOnline={hostsById.get(widget.host_id)?.status === "online"}
          onActions={() => onPaneActions(tile)}
          onOpen={() => onOpenFiles(widget.host_id, widget.path)}
          paneId={tile.session_id}
          path={widget.path}
        />
      ) : session ? (
        <TerminalRow
          agents={agents}
          host={hostsById.get(session.host_id) ?? null}
          onActions={() => onPaneActions(tile)}
          onOpen={() => onOpenTerminal(session.id)}
          session={session}
          transport={transports[session.id] ?? "idle"}
        />
      ) : (
        <MissingPaneRow onActions={() => onPaneActions(tile)} paneId={tile.session_id} />
      );

      if (!paneDrag || !onPaneDragBegin || !onPaneDragEnd) return row;
      const ghost: PaneGhost = session
        ? {
            title: sessionTitle(session, agents),
            identity: identifyAgent(session.foreground_command, agents),
          }
        : {
            title: isFilesWidget(widget) ? "Files" : "Session unavailable",
            identity: identifyAgent(null, agents),
          };
      return (
        <DraggablePane
          drag={paneDrag}
          enabled={draggingPaneId === null || draggingPaneId === tile.session_id}
          lifted={draggingPaneId === tile.session_id}
          onBegin={() => onPaneDragBegin(tile, ghost)}
          onDrop={onPaneDragEnd}
        >
          {row}
        </DraggablePane>
      );
    },
    [
      agents,
      draggingPaneId,
      hostsById,
      onOpenFiles,
      onOpenTerminal,
      onPaneActions,
      onPaneDragBegin,
      onPaneDragEnd,
      paneDrag,
      sessionsById,
      transports,
    ],
  );

  return (
    <FlashList
      contentContainerStyle={styles.listContent}
      data={tiles}
      ItemSeparatorComponent={ListSeparator}
      keyExtractor={(tile) => tile.session_id}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <EmptyState
            action={<AddPaneControl canAddPane={canAddPane} onAddPane={onAddPane} />}
            description="The circle is empty. Spawn something into it."
            icon="SquareTerminal"
            title="Open your first window"
          />
        </View>
      }
      ListFooterComponent={
        tiles.length > 0 ? (
          <>
            {/* The rule that closes the list: without it the last pane's row
                trails off into the space the add control stands in. */}
            <ListSeparator />
            <View style={styles.footer}>
              <AddPaneControl canAddPane={canAddPane} onAddPane={onAddPane} />
            </View>
          </>
        ) : null
      }
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={refreshing}
          tintColor={theme.colors.mutedForeground}
        />
      }
      renderItem={renderItem}
      // A pane being carried must not also scroll the list out from under it.
      scrollEnabled={draggingPaneId === null}
      showsVerticalScrollIndicator={false}
      testID={`pane-list-${tab.id}`}
    />
  );
});

function AddPaneControl({ canAddPane, onAddPane }: { canAddPane: boolean; onAddPane: () => void }) {
  return (
    <View style={styles.addControl}>
      <Button
        accessibilityHint={
          canAddPane ? undefined : "This tab is full. A tab can contain up to 16 panes."
        }
        disabled={!canAddPane}
        onPress={onAddPane}
        style={styles.fullWidth}
        variant="outline"
      >
        <Icon name="Plus" size={sizing.control.spinner} />
        Add terminal or files
      </Button>
      {!canAddPane ? (
        <Text color="warning" style={styles.blockedReason} variant="caption">
          This tab is full. A tab can contain up to 16 panes.
        </Text>
      ) : null}
    </View>
  );
}

function MissingPaneRow({ paneId, onActions }: { paneId: string; onActions: () => void }) {
  return (
    <View testID={`missing-row-${paneId}`}>
      <ListRow
        leading={<StatusDot tone="offline" />}
        onLongPress={() => {
          haptics.impact("medium");
          onActions();
        }}
        onPress={onActions}
        shape="fullBleed"
        subtitle="Refresh or remove this pane."
        title="Session unavailable"
        trailing={<Icon color="mutedForeground" name="Ellipsis" />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  addControl: {
    alignItems: "stretch",
    gap: sizing.space.peer,
    width: "100%",
  },
  blockedReason: {
    textAlign: "center",
  },
  footer: {
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: sizing.space.block,
  },
  fullWidth: {
    width: "100%",
  },
  listContent: {
    // Two panes leave most of the tab empty. Without this the scrollable
    // content stops under the last row, and a pull started in the space below
    // it lands on nothing instead of on the refresh control.
    flexGrow: 1,
    paddingBottom: sizing.space.block,
    paddingTop: sizing.space.cluster,
  },
  emptyState: {
    paddingHorizontal: sizing.screen.gutter,
  },
});
