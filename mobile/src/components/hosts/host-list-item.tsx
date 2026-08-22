import { StyleSheet, View } from "react-native";
import { hostConnectionLabel, pluralize } from "@/components/hosts/host-model";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import type { HostOut } from "@/data/api/schemas/hosts";
import { haptics } from "@/lib/haptics";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface HostListItemProps {
  host: HostOut;
  onOpen(): void;
  onOpenActions(): void;
}

export function HostListItem({ host, onOpen, onOpenActions }: HostListItemProps) {
  const theme = useTheme();
  const online = host.status === "online";
  const system = `${host.os ?? "unknown"}/${host.arch ?? "unknown"} · daemon ${host.version ?? "unknown"}`;

  return (
    <View testID={`host-row-${host.id}`}>
      <ListRow
        height="tall"
        leading={
          <View
            style={[
              styles.machine,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Icon color="mutedForeground" name="Server" size={spacing[4]} />
            <StatusDot
              accessibilityLabel={online ? "Online" : "Offline"}
              bordered
              pulse={false}
              style={styles.statusDot}
              testID={`host-status-${host.id}`}
              tone={online ? "active" : "offline"}
            />
          </View>
        }
        onLongPress={() => {
          haptics.impact("medium");
          onOpenActions();
        }}
        onPress={() => {
          haptics.selection();
          onOpen();
        }}
        shape="fullBleed"
        subtitle={`${hostConnectionLabel(host)}\n${system}`}
        title={host.name}
        trailing={
          <View style={styles.trailing}>
            <Badge testID={`host-session-count-${host.id}`} variant="outline">
              {pluralize(host.session_count, "session")}
            </Badge>
            <IconButton
              accessibilityLabel={`Actions for ${host.name}`}
              icon="Ellipsis"
              onPress={onOpenActions}
              size="sm"
            />
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  machine: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: sizing.listRow.leading.rich,
    justifyContent: "center",
    position: "relative",
    width: sizing.listRow.leading.rich,
  },
  statusDot: {
    bottom: -spacing[0.5],
    position: "absolute",
    right: -spacing[0.5],
  },
  trailing: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[1],
  },
});
