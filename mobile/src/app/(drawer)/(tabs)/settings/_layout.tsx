import { DestinationStack } from "@/components/nav/destination-stack";

export const unstable_settings = { initialRouteName: "index" };

export default function SettingsStackLayout(): React.JSX.Element {
  return <DestinationStack initialRouteName="index" />;
}
