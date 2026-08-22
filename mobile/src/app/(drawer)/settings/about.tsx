import { Screen } from "@/components/layout/screen";
import { AboutScreen } from "@/components/longtail/about-screen";

export default function AboutSettingsRoute(): React.JSX.Element {
  return (
    <Screen padded={false}>
      <AboutScreen />
    </Screen>
  );
}
