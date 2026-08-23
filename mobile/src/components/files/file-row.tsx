import { Pressable, StyleSheet, View } from "react-native";
import { FileKindIcon } from "@/components/files/file-icon";
import { classifyFile } from "@/components/files/file-kinds";
import { formatFileSize, formatModifiedTime } from "@/components/files/format";
import type { HostDirEntry } from "@/components/files/types";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, spacing, useTheme } from "@/theme";

export interface FileRowProps {
  entry: HostDirEntry;
  onOpen: (entry: HostDirEntry) => void;
  onActions: (entry: HostDirEntry) => void;
}

export function FileRow({ entry, onOpen, onActions }: FileRowProps) {
  const theme = useTheme();
  const type = classifyFile(entry);
  const detail = entry.is_dir
    ? formatModifiedTime(entry.modified_at)
    : `${formatFileSize(entry.size)} · ${formatModifiedTime(entry.modified_at)}`;
  return (
    <Pressable
      accessibilityLabel={`${entry.is_dir ? "Folder" : type.label}: ${entry.name}`}
      accessibilityRole="button"
      onLongPress={() => {
        haptics.impact("medium");
        onActions(entry);
      }}
      onPress={() => {
        haptics.selection();
        onOpen(entry);
      }}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.colors.accent : theme.colors.background,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <FileKindIcon icon={type.icon} kind={entry.kind} />
      <View style={styles.copy}>
        <Text numberOfLines={1} variant="body" weight="medium">
          {entry.name}
        </Text>
        <Text color="mutedForeground" numberOfLines={1} variant="caption">
          {detail}
        </Text>
      </View>
      {entry.is_dir ? (
        <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
      ) : (
        <Pressable
          accessibilityLabel={`Actions for ${entry.name}`}
          accessibilityRole="button"
          hitSlop={spacing[2]}
          onPress={(event) => {
            event.stopPropagation();
            haptics.selection();
            onActions(entry);
          }}
          style={({ pressed }) => [
            styles.actions,
            { opacity: pressed ? opacity.hoverButton : opacity.opaque },
          ]}
        >
          <Icon color="mutedForeground" name="Ellipsis" size={spacing[4]} />
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
    width: chrome.touchTarget,
  },
  copy: {
    flex: 1,
    gap: spacing[0.5],
    minWidth: 0,
  },
  row: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: spacing[16],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
