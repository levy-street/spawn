import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

export interface SettingsSectionProps {
  title?: string;
  description?: string;
  children: ReactNode;
  testID?: string;
}

export function SettingsSection({
  title,
  description,
  children,
  testID,
}: SettingsSectionProps): React.JSX.Element {
  return (
    <View style={styles.section} testID={testID}>
      {title || description ? (
        <View style={styles.heading}>
          {title ? (
            <Text variant="caption" weight="semibold">
              {title}
            </Text>
          ) : null}
          {description ? (
            <Text color="mutedForeground" variant="caption">
              {description}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[2],
  },
  heading: {
    gap: spacing[1],
  },
  section: {
    gap: spacing[3],
  },
});
