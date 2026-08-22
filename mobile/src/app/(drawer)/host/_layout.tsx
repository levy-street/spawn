import { DestinationStack } from "@/components/nav/destination-stack";

export const unstable_settings = { initialRouteName: "[id]/index" };

export default function HostStackLayout(): React.JSX.Element {
  return <DestinationStack initialRouteName="[id]/index" />;
}
