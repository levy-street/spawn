import type { ReactNode } from "react";
import { View } from "react-native";

import { Screen } from "@/components/layout/screen";
import { WorkspaceListError } from "@/components/workspaces/workspace-list-error";
import { WorkspaceListSkeletons } from "@/components/workspaces/workspace-list-skeletons";
import { workspaceListStyles as styles } from "@/components/workspaces/workspace-list-styles";
import { useTheme } from "@/theme";

interface WorkspaceListStateFrameProps {
  children: ReactNode;
  header: ReactNode;
}

function WorkspaceListStateFrame({
  children,
  header,
}: WorkspaceListStateFrameProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Screen header={header} padded={false}>
      <View
        style={[styles.screen, { backgroundColor: theme.colors.background }]}
        testID="workspace-list-screen"
      >
        {children}
      </View>
    </Screen>
  );
}

export function WorkspaceListLoading({ header }: { header: ReactNode }): React.JSX.Element {
  return (
    <WorkspaceListStateFrame header={header}>
      <WorkspaceListSkeletons />
    </WorkspaceListStateFrame>
  );
}

interface WorkspaceListFailureProps {
  header: ReactNode;
  message: string;
  onRetry: () => void;
}

export function WorkspaceListFailure({
  header,
  message,
  onRetry,
}: WorkspaceListFailureProps): React.JSX.Element {
  return (
    <WorkspaceListStateFrame header={header}>
      <WorkspaceListError message={message} onRetry={onRetry} />
    </WorkspaceListStateFrame>
  );
}
