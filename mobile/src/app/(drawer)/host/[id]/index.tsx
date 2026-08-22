import { useLocalSearchParams } from "expo-router";
import { HostDetailScreen } from "@/components/hosts/host-detail-screen";

export default function HostDetailRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const hostId = Array.isArray(params.id) ? (params.id[0] ?? "") : (params.id ?? "");
  return <HostDetailScreen hostId={hostId} />;
}
