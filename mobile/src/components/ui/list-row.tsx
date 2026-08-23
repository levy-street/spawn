import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text, type TextWeight } from "@/components/ui/text";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface ListRowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  /**
   * Content under the row's copy and inside the same press target — meters,
   * chips, anything the two text lines cannot carry.
   */
  body?: ReactNode;
  /** Named for assistive tech, since `body` itself is merged into the row. */
  bodyLabel?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  height?: "regular" | "tall";
  /** Full-bleed row with square corners, for separator-joined lists. Default "inset". */
  shape?: "inset" | "fullBleed";
  /** Weight of the row's title. Default "medium"; "normal" for a quieter row. */
  titleWeight?: TextWeight;
}

export function ListRow({
  body,
  bodyLabel,
  height = "regular",
  leading,
  onLongPress,
  onPress,
  shape = "inset",
  subtitle,
  title,
  titleWeight = "medium",
  trailing,
}: ListRowProps): React.JSX.Element {
  const theme = useTheme();
  const interactive = onPress !== undefined || onLongPress !== undefined;

  return (
    <Pressable
      accessibilityLabel={[title, subtitle, bodyLabel].filter(Boolean).join(", ")}
      accessibilityRole={interactive ? "button" : undefined}
      accessible
      onLongPress={onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.frame,
        height === "tall" ? styles.tall : styles.regular,
        {
          backgroundColor: pressed ? theme.colors.accent : "transparent",
          borderRadius: shape === "fullBleed" ? borderWidth.none : theme.radii.lg,
        },
      ]}
    >
      <View style={styles.container}>
        {leading !== undefined ? (
          <View accessibilityElementsHidden style={styles.leading}>
            {leading}
          </View>
        ) : null}
        <View style={styles.copy}>
          <Text numberOfLines={1} style={styles.title} variant="label" weight={titleWeight}>
            {title}
          </Text>
          {subtitle !== undefined ? (
            <Text
              color="mutedForeground"
              numberOfLines={2}
              style={styles.subtitle}
              variant="caption"
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {trailing !== undefined ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
      {body === undefined ? null : <View style={styles.body}>{body}</View>}
    </Pressable>
  );
}

/**
 * The divider between separator-joined rows. It runs edge to edge on purpose:
 * a one-sided inset reads as a misalignment rather than as a style, and every
 * list in the app that offered the choice had already opted out of it.
 */
export function ListSeparator(): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[styles.separator, { backgroundColor: theme.colors.border }]}
      testID="list-separator"
    />
  );
}

const styles = StyleSheet.create({
  body: {
    gap: sizing.listRow.bodyGap,
    paddingTop: sizing.listRow.bodyGap,
  },
  container: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.listRow.contentGap,
    width: "100%",
  },
  copy: {
    flex: 1,
    gap: sizing.listRow.textGap,
    minWidth: 0,
  },
  frame: {
    // The row's own padding lives here rather than on the content row, so a
    // body drawn under it sits inside the same frame instead of alongside it.
    justifyContent: "center",
    paddingHorizontal: sizing.listRow.horizontalPadding,
    paddingVertical: sizing.listRow.verticalPadding,
    width: "100%",
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
  separator: {
    height: borderWidth.hairline,
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
