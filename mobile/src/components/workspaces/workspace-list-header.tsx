import { useMemo } from "react";

import { AppHeader, type AppHeaderAction } from "@/components/layout/app-header";

interface WorkspaceListHeaderProps {
  canCreate: boolean;
  onCreate: () => void;
}

export function WorkspaceListHeader({
  canCreate,
  onCreate,
}: WorkspaceListHeaderProps): React.JSX.Element {
  // Hosts and Settings are reached from the persistent tab bar and nowhere else,
  // so this header carries only what is specific to the workspace list.
  const actions = useMemo<readonly AppHeaderAction[]>(
    () => [
      {
        accessibilityLabel: "New workspace",
        disabled: !canCreate,
        icon: "Plus",
        onPress: onCreate,
        testID: "new-workspace-button",
      },
    ],
    [canCreate, onCreate],
  );

  return <AppHeader actions={actions} testID="workspace-list-header" title="Workspaces" />;
}
