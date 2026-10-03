import { PairingScreen } from "@/components/onboarding/pairing-screen";
import { POSSESS_A_HOST, POSSESS_A_HOST_LEAD } from "@/components/onboarding/possess-copy";

/** Where every "Possess a host" control leads: the browser's dialog, as a screen. */
export default function PossessHostScreen(): React.JSX.Element {
  return <PairingScreen lead={POSSESS_A_HOST_LEAD} title={POSSESS_A_HOST} />;
}
