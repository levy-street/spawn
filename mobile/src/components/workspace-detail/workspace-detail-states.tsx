import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { borderWidth, useTheme } from "@/theme";

export function WorkspaceLoadingState() {
  const theme = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
      <Spinner label="Loading workspace" size={theme.space(5)} />
    </View>
  );
}

export interface WorkspaceUnavailableStateProps {
  message: string;
  onRetry: () => void;
}

export function WorkspaceUnavailableState({ message, onRetry }: WorkspaceUnavailableStateProps) {
  const theme = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: theme.colors.background }]}>
      <EmptyState
        action={
          <Button onPress={onRetry} size="sm">
            Try again
          </Button>
        }
        description={message}
        icon="AlertCircle"
        title="Workspace unavailable"
      />
    </View>
  );
}

export function WorkspaceErrorBanner({ message }: { message: string }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[
        styles.error,
        {
          backgroundColor: theme.colors.destructiveSoft,
          borderBottomColor: theme.colors.destructive,
          borderBottomWidth: borderWidth.hairline,
          gap: theme.space(2),
          paddingHorizontal: theme.space(3),
          paddingVertical: theme.space(2),
        },
      ]}
    >
      <Icon color="destructive" name="AlertCircle" />
      <Text color="destructive" style={styles.errorCopy} variant="caption">
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  error: {
    alignItems: "center",
    flexDirection: "row",
  },
  errorCopy: {
    flex: 1,
  },
});
