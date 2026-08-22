import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface ListRowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  height?: "regular" | "tall";
}

export function ListRow({
  height = "regular",
  leading,
  onLongPress,
  onPress,
  subtitle,
  title,
  trailing,
}: ListRowProps): React.JSX.Element {
  const theme = useTheme();
  const interactive = onPress !== undefined || onLongPress !== undefined;

  return (
    <Pressable
      accessibilityLabel={subtitle === undefined ? title : `${title}, ${subtitle}`}
      accessibilityRole={interactive ? "button" : undefined}
      accessible
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        height === "tall" ? styles.tall : styles.regular,
        {
          backgroundColor: pressed ? theme.colors.accent : "transparent",
          borderRadius: theme.radii.lg,
        },
      ]}
    >
      {leading !== undefined ? (
        <View accessibilityElementsHidden style={styles.leading}>
          {leading}
        </View>
      ) : null}
      <View style={styles.copy}>
        <Text numberOfLines={1} style={styles.title} variant="label" weight="medium">
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text color="mutedForeground" numberOfLines={2} style={styles.subtitle} variant="caption">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing !== undefined ? <View style={styles.trailing}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.listRow.contentGap,
    paddingHorizontal: sizing.listRow.horizontalPadding,
    paddingVertical: sizing.listRow.verticalPadding,
    width: "100%",
  },
  copy: {
    flex: 1,
    gap: sizing.listRow.textGap,
    minWidth: 0,
  },
  leading: {
    alignItems: "center",
    height: sizing.listRow.leading.rich,
    justifyContent: "center",
    width: sizing.listRow.leading.rich,
  },
  regular: {
    minHeight: sizing.listRow.regular,
  },
  subtitle: {
    fontSize: sizing.type.caption.fontSize,
    lineHeight: sizing.type.caption.lineHeight,
  },
  tall: {
    minHeight: sizing.listRow.tall,
  },
  title: {
    fontSize: sizing.type.rowLabel.fontSize,
    lineHeight: sizing.type.rowLabel.lineHeight,
  },
  trailing: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: sizing.listRow.trailingTarget,
    minWidth: sizing.listRow.trailingTarget,
  },
});
