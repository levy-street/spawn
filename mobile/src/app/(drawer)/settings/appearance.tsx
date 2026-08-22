import { Screen } from "@/components/layout/screen";
import { AppearancePanel } from "@/components/settings/appearance-panel";

export default function AppearanceSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AppearancePanel />
    </Screen>
  );
}
