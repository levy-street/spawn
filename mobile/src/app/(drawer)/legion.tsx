import { LegionScreen } from "@/components/hosts/legion-screen";
import { Screen } from "@/components/layout/screen";

export default function LegionRoute() {
  return (
    <Screen padded={false}>
      <LegionScreen />
    </Screen>
  );
}
