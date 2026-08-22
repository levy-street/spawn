import { AdminInvitesScreen } from "@/components/admin/admin-invites-screen";
import { Screen } from "@/components/layout/screen";

export default function AdminInvitesRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AdminInvitesScreen />
    </Screen>
  );
}
