import { Screen } from "@/components/layout/screen";
import { TemplatesPanel } from "@/components/settings/templates-panel";

export default function TemplatesSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <TemplatesPanel />
    </Screen>
  );
}
