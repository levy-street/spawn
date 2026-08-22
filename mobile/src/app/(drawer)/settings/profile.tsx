import { Screen } from "@/components/layout/screen";
import { ProfileScreen } from "@/components/settings/profile-screen";

export default function ProfileSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <ProfileScreen />
    </Screen>
  );
}
