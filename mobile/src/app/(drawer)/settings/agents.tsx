import { Screen } from "@/components/layout/screen";
import { AgentsPanel } from "@/components/settings/agents-panel";

export default function AgentsSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AgentsPanel />
    </Screen>
  );
}
