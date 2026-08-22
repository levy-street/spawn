import { Screen } from "@/components/layout/screen";
import { ArchivedWorkspacesScreen } from "@/components/longtail/archived-workspaces-screen";

export default function ArchivedWorkspacesRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <ArchivedWorkspacesScreen />
    </Screen>
  );
}
