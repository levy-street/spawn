import { Stack, useLocalSearchParams } from "expo-router";
import { HostAgentsScreen } from "@/components/hosts/host-agents-screen";

export default function HostAgentsRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const hostId = Array.isArray(params.id) ? (params.id[0] ?? "") : (params.id ?? "");
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <HostAgentsScreen hostId={hostId} />
    </>
  );
}
