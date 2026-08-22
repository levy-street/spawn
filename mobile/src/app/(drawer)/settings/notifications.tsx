import { Screen } from "@/components/layout/screen";
import { NotificationsPanel } from "@/components/settings/notifications-panel";

export default function NotificationsSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <NotificationsPanel />
    </Screen>
  );
}
