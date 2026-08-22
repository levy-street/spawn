import { Screen } from "@/components/layout/screen";
import { PairingScreen } from "@/components/onboarding/pairing-screen";

export default function DevicePairingScreen(): React.JSX.Element {
  return (
    <Screen padded={false} scroll>
      <PairingScreen />
    </Screen>
  );
}
