import { useLocalSearchParams } from "expo-router";

import { DeviceApprovalScreen } from "@/components/trust/device-approval-screen";

function routeHostId(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

export default function DeviceApprovalRoute(): React.JSX.Element {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>();
  const hostId = routeHostId(params.hostId);
  return <DeviceApprovalScreen {...(hostId === undefined ? {} : { hostId })} />;
}
