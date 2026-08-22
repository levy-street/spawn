import { AdminUsersScreen } from "@/components/admin/admin-users-screen";
import { Screen } from "@/components/layout/screen";

export default function AdminUsersRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AdminUsersScreen />
    </Screen>
  );
}
