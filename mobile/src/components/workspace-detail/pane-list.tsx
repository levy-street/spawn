import { FlashList } from "@shopify/flash-list";
import { memo, useCallback, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { FilesWidgetRow } from "@/components/workspace-detail/files-widget-row";
import { TerminalRow } from "@/components/workspace-detail/terminal-row";
import { readingOrder } from "@/data/layout/mobile-order";
import type { AgentDef, Host, Session, TransportState } from "@/data/types/domain";
import { isFilesWidget, type Tile, type WorkspaceTab } from "@/data/types/layout";
import { borderWidth, chrome, useTheme } from "@/theme";

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
  onRenameSession: (session: Session) => void;
  onMovePane: (tile: Tile) => void;
  onRemovePane: (tile: Tile) => void;
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
  onRenameSession,
  onMovePane,
  onRemovePane,
}: PaneListProps) {
  const theme = useTheme();
  const tiles = useMemo(() => readingOrder(tab), [tab]);

  const renderItem = useCallback(
    ({ item: tile }: { item: Tile }) => {
      const widget = tile.widget;
      if (isFilesWidget(widget)) {
        const host = hostsById.get(widget.host_id) ?? null;
        return (
          <FilesWidgetRow
            hostName={host?.name ?? null}
            hostOnline={host?.status === "online"}
            onActions={() => onPaneActions(tile)}
            onMove={() => onMovePane(tile)}
            onOpen={() => onOpenFiles(widget.host_id, widget.path)}
            onRemove={() => onRemovePane(tile)}
            paneId={tile.session_id}
            path={widget.path}
          />
        );
      }

      const session = tile.widget ? null : (sessionsById.get(tile.session_id) ?? null);
      if (!session) {
        return <MissingPaneRow onActions={() => onPaneActions(tile)} paneId={tile.session_id} />;
      }
      return (
        <TerminalRow
          agents={agents}
          host={hostsById.get(session.host_id) ?? null}
          onActions={() => onPaneActions(tile)}
          onClose={() => onRemovePane(tile)}
          onMove={() => onMovePane(tile)}
          onOpen={() => onOpenTerminal(session.id)}
          onRename={() => onRenameSession(session)}
          session={session}
          transport={transports[session.id] ?? "idle"}
        />
      );
    },
    [
      agents,
      hostsById,
      onMovePane,
      onOpenFiles,
      onOpenTerminal,
      onPaneActions,
      onRemovePane,
      onRenameSession,
      sessionsById,
      transports,
    ],
  );

  return (
    <FlashList
      contentContainerStyle={{ padding: theme.space(3) }}
      data={tiles}
      ItemSeparatorComponent={() => <View style={{ height: theme.space(2) }} />}
      keyExtractor={(tile) => tile.session_id}
      ListEmptyComponent={
        <EmptyState
          action={
            <Button disabled={!canAddPane} onPress={onAddPane} size="sm">
              Add terminal or files
            </Button>
          }
          description="The circle is empty. Spawn something into it."
          icon="SquareTerminal"
          title="Open your first window"
        />
      }
      ListFooterComponent={
        tiles.length > 0 ? (
          <View style={[styles.footer, { paddingTop: theme.space(3) }]}>
            <Button disabled={!canAddPane} onPress={onAddPane} size="sm" variant="outline">
              <Icon name="Plus" />
              Add
            </Button>
          </View>
        ) : null
      }
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      testID={`pane-list-${tab.id}`}
    />
  );
});

function MissingPaneRow({ paneId, onActions }: { paneId: string; onActions: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel="Session unavailable"
      accessibilityRole="button"
      onLongPress={onActions}
      onPress={onActions}
      style={[
        styles.missing,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          borderWidth: borderWidth.hairline,
          gap: theme.space(3),
          minHeight: theme.space(18),
          paddingHorizontal: theme.space(3),
          paddingVertical: theme.space(2.5),
        },
      ]}
      testID={`missing-row-${paneId}`}
    >
      <StatusDot tone="offline" />
      <View style={styles.missingCopy}>
        <Text variant="label">Session unavailable</Text>
        <Text color="mutedForeground" variant="caption">
          Refresh or remove this pane.
        </Text>
      </View>
      <Icon color="mutedForeground" name="Ellipsis" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: "center",
  },
  missing: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: chrome.touchTarget,
  },
  missingCopy: {
    flex: 1,
    minWidth: 0,
  },
});
