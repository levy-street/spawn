import { AdminEmailScreen } from "@/components/admin/admin-email-screen";
import { Screen } from "@/components/layout/screen";

export default function AdminEmailsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AdminEmailScreen />
    </Screen>
  );
}
