import type { ReactNode } from "react";
import { ScrollView, type ScrollViewProps, StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text";
import { spacing, useTheme } from "@/theme";

export interface SettingsScreenProps extends Pick<ScrollViewProps, "refreshControl"> {
  title: string;
  description?: string;
  children: ReactNode;
  testID?: string;
}

export function SettingsScreen({
  title,
  description,
  children,
  refreshControl,
  testID,
}: SettingsScreenProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <ScrollView
      automaticallyAdjustContentInsets
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
      style={{ backgroundColor: theme.colors.background }}
      testID={testID}
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" variant="title">
          {title}
        </Text>
        {description ? (
          <Text color="mutedForeground" variant="body">
            {description}
          </Text>
        ) : null}
      </View>
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[6],
    padding: spacing[4],
    paddingBottom: spacing[20],
  },
  header: {
    gap: spacing[1],
  },
});
