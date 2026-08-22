import { SettingsInfoRow } from "@/components/settings/settings-row";
import { Badge } from "@/components/ui/badge";
import type { IconName } from "@/components/ui/icon";

export interface UnavailableRowProps {
  label: string;
  reason: string;
  icon?: IconName;
  testID?: string;
}

export function UnavailableRow({
  label,
  reason,
  icon,
  testID,
}: UnavailableRowProps): React.JSX.Element {
  return (
    <SettingsInfoRow
      hint={reason}
      {...(icon === undefined ? {} : { icon })}
      label={label}
      testID={testID}
      trailing={<Badge variant="outline">Unavailable</Badge>}
    />
  );
}
