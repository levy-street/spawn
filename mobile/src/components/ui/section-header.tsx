import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { Text } from "@/components/ui/text";
import { sizing } from "@/theme/sizing";

export interface SectionHeaderProps {
  description?: string;
  eyebrow?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title: string;
  trailing?: ReactNode;
}

export function SectionHeader({
  description,
  eyebrow,
  style,
  testID,
  title,
  trailing,
}: SectionHeaderProps): React.JSX.Element {
  return (
    <View style={[styles.container, style]} testID={testID}>
      <View style={styles.copy}>
        {eyebrow !== undefined ? (
          <Text color="mutedForeground" style={styles.eyebrow} variant="micro">
            {eyebrow}
          </Text>
        ) : null}
        <Text accessibilityRole="header" style={styles.title} variant="label" weight="semibold">
          {title}
        </Text>
        {description !== undefined ? (
          <Text color="mutedForeground" style={styles.description} variant="caption">
            {description}
          </Text>
        ) : null}
      </View>
      {trailing !== undefined ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.sectionHeader.contentGap,
    minHeight: sizing.sectionHeader.minHeight,
    paddingHorizontal: sizing.sectionHeader.horizontalPadding,
    paddingVertical: sizing.sectionHeader.verticalPadding,
    width: "100%",
  },
  copy: {
    flex: 1,
    gap: sizing.space.tight,
    minWidth: 0,
  },
  description: {
    fontSize: sizing.type.caption.fontSize,
    lineHeight: sizing.type.caption.lineHeight,
  },
  eyebrow: {
    fontSize: sizing.type.micro.fontSize,
    lineHeight: sizing.type.micro.lineHeight,
  },
  title: {
    fontSize: sizing.type.componentLabel.fontSize,
    lineHeight: sizing.type.componentLabel.lineHeight,
  },
  trailing: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: sizing.control.minimumTouchTarget,
  },
});
