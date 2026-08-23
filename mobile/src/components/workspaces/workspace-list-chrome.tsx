import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { SearchField } from "@/components/ui/search-field";
import { Text } from "@/components/ui/text";
import { ArchivedWorkspacesNavigationRow } from "@/components/workspaces/archived-workspaces-navigation-row";
import { workspaceListStyles as styles } from "@/components/workspaces/workspace-list-styles";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

interface WorkspaceListControlsProps {
  onQueryChange: (query: string) => void;
  query: string;
}

export function WorkspaceListControls({
  onQueryChange,
  query,
}: WorkspaceListControlsProps): React.JSX.Element {
  return (
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
  );
}

/**
 * Adding one more workspace belongs directly under the ones already there: the
 * header's + is a small target at the far top of a screen you scroll downwards.
 */
export function NewWorkspaceRow({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <View testID="new-workspace-row">
      <ListSeparator inset={false} />
      <ListRow
        leading={<Icon color="mutedForeground" name="Plus" size={sizing.control.icon} />}
        shape="fullBleed"
        title="New workspace"
        {...(disabled ? {} : { onPress })}
      />
    </View>
  );
}

/**
 * Archived workspaces sit at the foot of the screen rather than above the list:
 * it is a rarely-taken side road, so it belongs where it is reachable without
 * standing between the search and the workspaces themselves.
 */
export function ArchivedWorkspacesFooter({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <View testID="archived-workspaces-section">
      <ListSeparator inset={false} />
      <ArchivedWorkspacesNavigationRow count={count} onPress={onPress} />
    </View>
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
