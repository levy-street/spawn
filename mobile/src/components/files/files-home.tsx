import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { useFileHosts } from "@/data/queries/files";
import { sortHosts } from "@/data/selectors/host";
import type { Host } from "@/data/types/domain";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, spacing, useTheme } from "@/theme";

export function FilesHome() {
  const theme = useTheme();
  const hosts = useFileHosts();
  const rows = sortHosts(hosts.data ?? []);
  if (hosts.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <Spinner label="Loading hosts" size={spacing[6]} />
      </View>
    );
  }
  if (hosts.isError) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <EmptyState
          description="Could not load the machines linked to your account."
          icon="Unplug"
          title="Hosts unavailable"
        />
      </View>
    );
  }
  if (rows.length === 0) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <EmptyState
          description="Pair a host to browse its home folder from anywhere."
          icon="FolderSearch"
          title="No hosts yet"
        />
      </View>
    );
  }
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: theme.type.fontSize.displayLg, lineHeight: theme.type.lineHeight.xl }}
          variant="title"
        >
          Files
        </Text>
        <Text color="mutedForeground" variant="body">
          Browse files directly on your hosts.
        </Text>
      </View>
      <FlashList
        data={rows}
        keyExtractor={(host) => host.id}
        renderItem={({ item }) => <HostFileRow host={item} />}
      />
    </View>
  );
}

function HostFileRow({ host }: { host: Host }) {
  const theme = useTheme();
  const online = host.status === "online";
  return (
    <Pressable
      accessibilityLabel={`Browse files on ${host.name}${online ? "" : ", offline"}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !online }}
      disabled={!online}
      onPress={() => {
        haptics.selection();
        router.push({ pathname: "/host/[id]/files", params: { id: host.id } });
      }}
      style={({ pressed }) => [
        styles.hostRow,
        {
          backgroundColor: pressed ? theme.colors.accent : theme.colors.background,
          borderBottomColor: theme.colors.border,
          opacity: online ? opacity.opaque : opacity.disabled,
        },
      ]}
    >
      <View
        style={[
          styles.hostIcon,
          { backgroundColor: theme.colors.muted, borderRadius: theme.radii.lg },
        ]}
      >
        <Icon color="mutedForeground" name="Server" size={spacing[5]} />
      </View>
      <View style={styles.hostCopy}>
        <Text numberOfLines={1} variant="body" weight="medium">
          {host.name}
        </Text>
        <Text color="mutedForeground" numberOfLines={1} variant="caption">
          {[host.os, host.arch].filter(Boolean).join(" · ") || "Host"}
        </Text>
      </View>
      <StatusDot
        accessibilityLabel={host.status}
        pulse={online}
        tone={online ? "active" : "offline"}
      />
      <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", flex: 1, justifyContent: "center" },
  header: {
    gap: spacing[1],
    paddingBottom: spacing[4],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[6],
  },
  hostCopy: { flex: 1, minWidth: 0 },
  hostIcon: {
    alignItems: "center",
    height: spacing[10],
    justifyContent: "center",
    width: spacing[10],
  },
  hostRow: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget + spacing[6],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  root: { flex: 1 },
});
