import { useRouter } from "expo-router";
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
  const router = useRouter();
  const actions = useMemo<readonly AppHeaderAction[]>(
    () => [
      {
        accessibilityLabel: "New workspace",
        disabled: !canCreate,
        icon: "Plus",
        onPress: onCreate,
        testID: "new-workspace-button",
      },
      {
        accessibilityLabel: "Open hosts",
        icon: "Server",
        onPress: () => router.push("/hosts"),
      },
      {
        accessibilityLabel: "Open settings",
        icon: "Settings",
        onPress: () => router.push("/settings"),
      },
    ],
    [canCreate, onCreate, router],
  );

  return <AppHeader actions={actions} testID="workspace-list-header" title="Workspaces" />;
}
