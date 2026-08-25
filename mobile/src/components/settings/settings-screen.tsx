import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, type ScrollViewProps, StyleSheet } from "react-native";
import { AppHeader, type AppHeaderProps } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Text } from "@/components/ui/text";
import { spacing, useTheme } from "@/theme";

export interface SettingsScreenProps extends Pick<ScrollViewProps, "refreshControl"> {
  title: string;
  description?: string;
  children: ReactNode;
  testID?: string;
  /**
   * A destination root rather than a page pushed onto one. Roots carry the
   * profile control and no back chevron, exactly like Workspaces; panels pushed
   * from a root carry the chevron.
   */
  root?: boolean;
  /** Header actions for this screen. Primary nav destinations are filtered out. */
  actions?: AppHeaderProps["actions"];
}

export function SettingsScreen({
  title,
  description,
  children,
  refreshControl,
  testID,
  root = false,
  actions,
}: SettingsScreenProps): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();

  return (
    <Screen
      header={
        <AppHeader
          {...(actions === undefined ? {} : { actions })}
          {...(root ? { branded: true } : { onBack: router.back })}
          title={title}
        />
      }
      padded={false}
    >
      <ScrollView
        // Pull-to-refresh needs the bounce; a page without it that fits the
        // screen has nothing to rubber-band for.
        alwaysBounceVertical={refreshControl !== undefined}
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
