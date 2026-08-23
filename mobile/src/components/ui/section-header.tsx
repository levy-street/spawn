import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { ListGroupHeading } from "@/components/ui/list-group";
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

/**
 * A section's heading, drawn the way every list on every page draws one.
 *
 * The eyebrow is the only part this adds over `ListGroupHeading`; the heading
 * itself deliberately lives there, so a section on a host page and a section in
 * settings cannot drift apart.
 */
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
      {eyebrow === undefined ? null : (
        <Text color="mutedForeground" style={styles.eyebrow} variant="micro">
          {eyebrow}
        </Text>
      )}
      <ListGroupHeading
        title={title}
        {...(description === undefined ? {} : { description })}
        {...(trailing === undefined ? {} : { trailing })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: sizing.space.tight,
    width: "100%",
  },
  eyebrow: {
    fontSize: sizing.type.micro.fontSize,
    lineHeight: sizing.type.micro.lineHeight,
  },
});
