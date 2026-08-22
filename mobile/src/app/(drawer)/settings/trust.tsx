import { Screen } from "@/components/layout/screen";
import { DeviceTrustPanel } from "@/components/settings/device-trust-panel";

export default function DeviceTrustSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <DeviceTrustPanel />
    </Screen>
  );
}
