import { Screen } from "@/components/layout/screen";
import { ServerPanel } from "@/components/settings/server-panel";

export default function ServerSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <ServerPanel />
    </Screen>
  );
}
