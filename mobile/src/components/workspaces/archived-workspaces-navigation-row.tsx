import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { sizing } from "@/theme/sizing";

export interface ArchivedWorkspacesNavigationRowProps {
  count: number;
  onPress: () => void;
}

export function ArchivedWorkspacesNavigationRow({
  count,
  onPress,
}: ArchivedWorkspacesNavigationRowProps): React.JSX.Element {
  const countLabel = `${count} ${count === 1 ? "workspace" : "workspaces"}`;

  return (
    <ListRow
      leading={<Icon color="mutedForeground" name="Archive" size={sizing.control.icon} />}
      onPress={onPress}
      shape="fullBleed"
      subtitle={countLabel}
      title="Archived workspaces"
      trailing={<Icon color="mutedForeground" name="ChevronRight" size={sizing.control.icon} />}
    />
  );
}
