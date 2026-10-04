import { useLocalSearchParams } from "expo-router";
import { cockpitTab } from "@/components/hosts/cockpit/cockpit-model";
import { HostCockpitScreen } from "@/components/hosts/cockpit/host-cockpit-screen";

export default function HostCockpitRoute() {
  const params = useLocalSearchParams<{ id?: string | string[]; tab?: string | string[] }>();
  const hostId = Array.isArray(params.id) ? (params.id[0] ?? "") : (params.id ?? "");
  return <HostCockpitScreen hostId={hostId} tab={cockpitTab(params.tab)} />;
}
