import { Screen } from "@/components/layout/screen";
import { WorkspaceListScreen } from "@/components/workspaces/workspace-list-screen";

export default function WorkspacesRoute() {
  return (
    <Screen padded={false}>
      <WorkspaceListScreen />
    </Screen>
  );
}
