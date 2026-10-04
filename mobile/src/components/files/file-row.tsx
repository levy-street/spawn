import { memo } from "react";
import { type AccessibilityActionEvent, Pressable, StyleSheet, View } from "react-native";
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
  /** Long-press: starts selecting, with this row picked. */
  onSelect?: (entry: HostDirEntry) => void;
  /** Selection mode: a tap toggles the row instead of opening it. */
  selecting?: boolean;
  selected?: boolean;
}

const ACCESSIBILITY_ACTIONS = [
  { name: "longpress", label: "Select" },
  { name: "actions", label: "More actions" },
] as const;

/**
 * One entry. Tap opens it; long-press starts selecting, which is what a long
 * press does in the phone's own Files app. Everything else about the entry is
 * behind its own ⋯, folders included, so no action needs the gesture.
 */
export const FileRow = memo(function FileRow({
  entry,
  onOpen,
  onActions,
  onSelect,
  selecting = false,
  selected = false,
}: FileRowProps) {
  const theme = useTheme();
  const type = classifyFile(entry);
  const detail = entry.is_dir
    ? formatModifiedTime(entry.modified_at)
    : `${formatFileSize(entry.size)} · ${formatModifiedTime(entry.modified_at)}`;
  const label = `${entry.is_dir ? "Folder" : type.label}: ${entry.name}`;
  const select = () => {
    haptics.impact("medium");
    onSelect?.(entry);
  };
  return (
    <Pressable
      accessibilityActions={selecting || !onSelect ? undefined : ACCESSIBILITY_ACTIONS}
      accessibilityLabel={label}
      accessibilityRole={selecting ? "checkbox" : "button"}
      accessibilityState={selecting ? { checked: selected } : undefined}
      onAccessibilityAction={(event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === "longpress") select();
        else if (event.nativeEvent.actionName === "actions") onActions(entry);
      }}
      onLongPress={selecting ? () => onOpen(entry) : select}
      onPress={() => {
        haptics.selection();
        onOpen(entry);
      }}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed || selected ? theme.colors.accent : theme.colors.background,
          borderBottomColor: theme.colors.border,
        },
      ]}
      testID={`file-row-${entry.name}`}
    >
      {selecting ? (
        <Icon
          color={selected ? "primary" : "mutedForeground"}
          name={selected ? "CheckCircle2" : "Circle"}
          size={spacing[5]}
        />
      ) : null}
      <FileKindIcon icon={type.icon} kind={entry.kind} />
      <View style={styles.copy}>
        <Text numberOfLines={1} variant="body" weight="medium">
          {entry.name}
        </Text>
        <Text color="mutedForeground" numberOfLines={1} variant="caption">
          {detail}
        </Text>
      </View>
      {selecting ? null : (
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
});

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
