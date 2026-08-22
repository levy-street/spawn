import { AdminHomeScreen } from "@/components/admin/admin-home-screen";
import { Screen } from "@/components/layout/screen";

export default function AdminRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AdminHomeScreen />
    </Screen>
  );
}
