import { Screen } from "@/components/layout/screen";
import { BrowserDevicesPanel } from "@/components/settings/browser-devices-panel";

export default function BrowserDevicesSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <BrowserDevicesPanel />
    </Screen>
  );
}
