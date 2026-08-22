import { Pressable, StyleSheet, View } from "react-native";
import { hostConnectionLabel, pluralize } from "@/components/hosts/host-model";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";

export interface HostListItemProps {
  host: HostOut;
  onOpen(): void;
  onOpenActions(): void;
}

export function HostListItem({ host, onOpen, onOpenActions }: HostListItemProps) {
  const theme = useTheme();
  const online = host.status === "online";
  return (
    <View
      style={[
        styles.row,
        {
          borderBottomColor: theme.colors.border,
          minHeight: chrome.touchTarget + spacing[6],
          paddingLeft: spacing[4],
        },
      ]}
      testID={`host-row-${host.id}`}
    >
      <Pressable
        accessibilityLabel={`${host.name}, ${online ? "online" : "offline"}`}
        accessibilityRole="button"
        onLongPress={onOpenActions}
        onPress={onOpen}
        style={({ pressed }) => [
          styles.main,
          { backgroundColor: pressed ? theme.colors.accent : "transparent" },
        ]}
      >
        <StatusDot
          accessibilityLabel={online ? "Online" : "Offline"}
          pulse={false}
          tone={online ? "active" : "offline"}
        />
        <View style={styles.copy}>
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={styles.title} variant="label">
              {host.name}
            </Text>
            <Text color="mutedForeground" variant="caption">
              {pluralize(host.session_count, "session")}
            </Text>
          </View>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {online
              ? `${host.os ?? "unknown"}/${host.arch ?? "unknown"} · daemon ${host.version ?? "unknown"}`
              : hostConnectionLabel(host)}
          </Text>
        </View>
        <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
      </Pressable>
      <IconButton
        accessibilityLabel={`Actions for ${host.name}`}
        icon="Ellipsis"
        onPress={onOpenActions}
        size="sm"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  main: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: spacing[3],
    paddingRight: spacing[1],
  },
  row: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
  },
  title: {
    flex: 1,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
