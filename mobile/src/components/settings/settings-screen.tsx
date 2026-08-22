import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, type ScrollViewProps, StyleSheet } from "react-native";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { headerDestinationActions } from "@/components/nav/header-destinations";
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
  const router = useRouter();
  const theme = useTheme();
  const actions =
    title === "Settings"
      ? headerDestinationActions(["hosts", "admin"])
      : title === "Admin"
        ? headerDestinationActions(["hosts", "settings"])
        : undefined;

  return (
    <Screen
      header={
        <AppHeader
          {...(actions === undefined ? {} : { actions })}
          onBack={router.back}
          title={title}
        />
      }
      padded={false}
    >
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
        {description ? (
          <Text color="mutedForeground" variant="body">
            {description}
          </Text>
        ) : null}
        {children}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[6],
    padding: spacing[4],
    paddingBottom: spacing[20],
  },
});
