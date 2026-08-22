import { useRouter } from "expo-router";
import { SettingsInfoRow, SettingsLinkRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useHostsSettingsQuery } from "@/data/queries/settings";

export function HostsPanel(): React.JSX.Element {
  const router = useRouter();
  const hosts = useHostsSettingsQuery();
  const hostList = [...(hosts.data ?? [])].sort((left, right) => {
    const statusOrder = Number(right.status === "online") - Number(left.status === "online");
    return statusOrder || left.name.localeCompare(right.name);
  });

  return (
    <SettingsScreen testID="hosts-settings-panel" title="Hosts">
      <SettingsSection>
        <SettingsLinkRow
          hint="View details, rename, remove, and manage agent installs."
          icon="Server"
          label="Open Hosts"
          onPress={() => router.push("/(tabs)/hosts")}
        />
        <SettingsLinkRow
          hint="Approve a daemon using its eight-character code."
          icon="Plus"
          label="Connect a host"
          onPress={() => router.push("/(onboarding)/host")}
        />
      </SettingsSection>

      <SettingsSection title="CONNECTED HOSTS">
        {hosts.isError ? (
          <EmptyState
            description={`Failed to load hosts: ${hosts.error.message}`}
            icon="AlertCircle"
            title="Hosts unavailable"
          />
        ) : hostList.length === 0 && !hosts.isPending ? (
          <EmptyState icon="Server" title="No hosts are connected yet." />
        ) : (
          hostList.map((host) => (
            <SettingsInfoRow
              hint={`${host.os ?? "unknown"}/${host.arch ?? "unknown"} · daemon ${host.version ?? "unknown"} · ${host.session_count} ${host.session_count === 1 ? "session" : "sessions"}`}
              icon="Server"
              key={host.id}
              label={host.name}
              trailing={
                <Badge variant={host.status === "online" ? "success" : "outline"}>
                  {host.status === "online" ? "online" : "offline"}
                </Badge>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsScreen>
  );
}
