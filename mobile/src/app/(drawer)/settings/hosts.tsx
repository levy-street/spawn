import { Screen } from "@/components/layout/screen";
import { HostsPanel } from "@/components/settings/hosts-panel";

export default function HostsSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <HostsPanel />
    </Screen>
  );
}
