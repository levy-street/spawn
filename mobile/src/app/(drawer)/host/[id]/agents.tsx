import { useLocalSearchParams } from "expo-router";
import { HostAgentsScreen } from "@/components/hosts/host-agents-screen";
import { Screen } from "@/components/layout/screen";

export default function HostAgentsRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const hostId = Array.isArray(params.id) ? (params.id[0] ?? "") : (params.id ?? "");
  return (
    <Screen padded={false}>
      <HostAgentsScreen hostId={hostId} />
    </Screen>
  );
}
