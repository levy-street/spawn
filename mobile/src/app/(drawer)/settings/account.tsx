import { Screen } from "@/components/layout/screen";
import { AccountPanel } from "@/components/settings/account-panel";

export default function AccountSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AccountPanel />
    </Screen>
  );
}
