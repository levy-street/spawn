import { HostListScreen } from "@/components/hosts/host-list-screen";
import { Screen } from "@/components/layout/screen";

export default function HostsRoute() {
  return (
    <Screen padded={false}>
      <HostListScreen />
    </Screen>
  );
}
