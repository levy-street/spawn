import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { breadcrumbParts, type PathFlavor } from "@/components/files/paths";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { chrome, spacing, useTheme } from "@/theme";

export function FileBreadcrumbs({
  path,
  pathFlavor = "posix",
  homeDir,
  onNavigate,
}: {
  path: string;
  pathFlavor?: PathFlavor;
  homeDir: string;
  onNavigate: (path: string) => void;
}) {
  const theme = useTheme();
  const crumbs = breadcrumbParts(path, homeDir, pathFlavor);
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      // A scroll view grows to fill its column by default; this one is a strip
      // under the header, and the listing below it is what gets the room.
      style={styles.strip}
      testID="file-breadcrumbs"
    >
      {crumbs.map((crumb, index) => (
        <View key={crumb.path} style={styles.crumbGroup}>
          {index > 0 ? (
            <Icon color="mutedForeground" name="ChevronRight" size={spacing[3]} />
          ) : null}
          <Pressable
            accessibilityLabel={`Open ${crumb.label}`}
            accessibilityRole="button"
            onPress={() => {
              haptics.selection();
              onNavigate(crumb.path);
            }}
            style={({ pressed }) => [
              styles.crumb,
              {
                backgroundColor: pressed ? theme.colors.accent : "transparent",
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Text
              color={index === crumbs.length - 1 ? "foreground" : "mutedForeground"}
              numberOfLines={1}
              variant="caption"
            >
              {crumb.label}
            </Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: "center",
    paddingHorizontal: spacing[3],
  },
  crumb: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: chrome.touchTarget,
    paddingHorizontal: spacing[2],
  },
  crumbGroup: {
    alignItems: "center",
    flexDirection: "row",
  },
  strip: {
    flexGrow: 0,
    flexShrink: 0,
  },
});
