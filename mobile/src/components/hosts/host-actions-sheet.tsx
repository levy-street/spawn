import { ActionSheet } from "@/components/ui/action-sheet";
import { Icon } from "@/components/ui/icon";
import type { HostOut } from "@/data/api/schemas/hosts";

export interface HostActionsSheetProps {
  host: HostOut | null;
  onDismiss(): void;
  onOpen(host: HostOut): void;
  onRemove(host: HostOut): void;
  onRename(host: HostOut): void;
}

export function HostActionsSheet({
  host,
  onDismiss,
  onOpen,
  onRemove,
  onRename,
}: HostActionsSheetProps) {
  return (
    <ActionSheet
      actions={
        host
          ? [
              {
                id: "details",
                label: "Details",
                icon: <Icon color="mutedForeground" name="Server" />,
                onPress: () => onOpen(host),
              },
              {
                id: "rename",
                label: "Rename",
                icon: <Icon color="mutedForeground" name="Pencil" />,
                onPress: () => onRename(host),
              },
              {
                id: "remove",
                label: "Remove",
                destructive: true,
                icon: <Icon color="destructive" name="Trash2" />,
                onPress: () => onRemove(host),
              },
            ]
          : []
      }
      onDismiss={onDismiss}
      visible={host !== null}
      {...(host === null ? {} : { title: host.name })}
    />
  );
}
