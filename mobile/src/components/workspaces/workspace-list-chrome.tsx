import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ListSeparator } from "@/components/ui/list-row";
import { SearchField } from "@/components/ui/search-field";
import { Text } from "@/components/ui/text";
import { ArchivedWorkspacesNavigationRow } from "@/components/workspaces/archived-workspaces-navigation-row";
import { workspaceListStyles as styles } from "@/components/workspaces/workspace-list-styles";
import { useTheme } from "@/theme";

interface WorkspaceListControlsProps {
  archivedCount: number;
  onOpenArchived: () => void;
  onQueryChange: (query: string) => void;
  query: string;
}

export function WorkspaceListControls({
  archivedCount,
  onOpenArchived,
  onQueryChange,
  query,
}: WorkspaceListControlsProps): React.JSX.Element {
  return (
    <>
      <View testID="archived-workspaces-section">
        <ArchivedWorkspacesNavigationRow count={archivedCount} onPress={onOpenArchived} />
        <ListSeparator inset={false} />
      </View>
      <View testID="workspace-search-section">
        <View style={styles.searchControls}>
          <SearchField
            onChangeText={onQueryChange}
            placeholder="Search workspaces"
            testID="workspace-search"
            value={query}
          />
        </View>
        <ListSeparator inset={false} />
      </View>
    </>
  );
}

export function WorkspaceListStatusError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="alert"
      style={[styles.statusError, { borderColor: theme.colors.border }]}
    >
      <Text color="mutedForeground" variant="caption">
        Session status is unavailable.
      </Text>
      <Button onPress={onRetry} size="sm" variant="ghost">
        Retry
      </Button>
    </View>
  );
}
