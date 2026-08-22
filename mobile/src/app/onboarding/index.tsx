import { Screen } from "@/components/layout/screen";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export default function OnboardingScreen(): React.JSX.Element {
  return (
    <Screen padded={false} scroll>
      <OnboardingFlow />
    </Screen>
  );
}
