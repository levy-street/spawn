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
  // The count is the whole story here, so it belongs in the label rather than on
  // a second line restating the word "workspace" underneath it.
  const label = `${count} ${count === 1 ? "Archived workspace" : "Archived workspaces"}`;

  return (
    <ListRow
      leading={<Icon color="mutedForeground" name="Archive" size={sizing.control.icon} />}
      onPress={onPress}
      shape="fullBleed"
      title={label}
      titleWeight="normal"
      trailing={<Icon color="mutedForeground" name="ChevronRight" size={sizing.control.icon} />}
    />
  );
}
