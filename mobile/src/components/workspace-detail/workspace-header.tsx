import { AppHeader } from "@/components/layout/app-header";
import type { Workspace } from "@/data/types/domain";

export interface WorkspaceHeaderProps {
  workspace: Workspace;
  canAddPane: boolean;
  onBack: () => void;
  onAddPane: () => void;
  onActions: () => void;
}

/** Workspace chrome lives in the scene so it follows the native swipe-back transition. */
export function WorkspaceHeader({
  workspace,
  canAddPane,
  onBack,
  onAddPane,
  onActions,
}: WorkspaceHeaderProps): React.JSX.Element {
  return (
    <AppHeader
      actions={[
        {
          accessibilityLabel: "Add terminal or files",
          disabled: !canAddPane,
          icon: "Plus",
          onPress: onAddPane,
          testID: "header-add-pane",
        },
        {
          accessibilityLabel: "Workspace actions",
          icon: "Ellipsis",
          onPress: onActions,
          testID: "workspace-actions-button",
        },
      ]}
      onBack={onBack}
      title={workspace.name}
    />
  );
}
