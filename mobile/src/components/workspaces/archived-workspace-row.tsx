import { StyleSheet, View } from "react-native";

import { formatLongtailDate } from "@/components/longtail/longtail-format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { opacity, spacing } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface ArchivedWorkspaceRowProps {
  busy: boolean;
  workspace: WorkspaceOut;
  onDelete: () => void;
  onOpen: () => void;
  onRestore: () => void;
}

export function ArchivedWorkspaceRow({
  busy,
  workspace,
  onDelete,
  onOpen,
  onRestore,
}: ArchivedWorkspaceRowProps): React.JSX.Element {
  const tabCount = workspace.layout.tabs.length;
  const archivedWhen = formatLongtailDate(workspace.archived_at);

  return (
    <Card
      padded={false}
      style={[styles.card, { opacity: busy ? opacity.disabled : opacity.opaque }]}
      testID={`archived-workspace-${workspace.id}`}
      variant="flat"
    >
      <View pointerEvents={busy ? "none" : "auto"}>
        <ListRow
          height="tall"
          leading={
            <WorkspaceIcon
              icon={workspace.icon}
              name={workspace.name}
              size={sizing.listRow.leading.rich}
            />
          }
          {...(busy ? {} : { onPress: onOpen })}
          shape="fullBleed"
          subtitle={`${tabCount} ${tabCount === 1 ? "tab" : "tabs"} · archived ${archivedWhen}`}
          title={workspace.name}
          trailing={<Icon color="mutedForeground" name="ChevronRight" size={sizing.control.icon} />}
        />
      </View>
      <ListSeparator inset={false} />
      <View style={styles.actions}>
        <Button disabled={busy} onPress={onRestore} size="sm" variant="outline">
          <Icon color="foreground" name="RotateCcw" size={sizing.control.spinner} />
          Restore
        </Button>
        <IconButton
          accessibilityLabel={`Delete ${workspace.name} forever`}
          disabled={busy}
          icon="Trash2"
          onPress={onDelete}
          size="sm"
          variant="ghost"
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: sizing.space.cluster,
    paddingVertical: sizing.space.peer,
  },
  card: {
    gap: spacing[0],
    overflow: "hidden",
  },
});
