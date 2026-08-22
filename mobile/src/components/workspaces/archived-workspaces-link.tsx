import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { workspaceListStyles as styles } from "@/components/workspaces/workspace-list-styles";
import { spacing } from "@/theme";

export interface ArchivedWorkspacesLinkProps {
  count: number;
  onPress: () => void;
}

export function ArchivedWorkspacesLink({ count, onPress }: ArchivedWorkspacesLinkProps) {
  return (
    <Button
      accessibilityLabel="Open archived workspaces"
      onPress={onPress}
      style={styles.archivedButton}
      variant="ghost"
    >
      <Icon color="mutedForeground" name="Archive" size={spacing[4]} />
      Archived workspaces{count > 0 ? ` (${count})` : ""}
    </Button>
  );
}
