import { ScrollView, StyleSheet, View } from "react-native";

import { ChoiceRow } from "@/components/launcher/choice-row";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { spacing } from "@/theme";

export interface HostStepProps {
  hosts: readonly HostOut[];
  selectedHostId: string | null;
  onSelect(host: HostOut): void;
}

function hostDetail(host: HostOut): string {
  const presence = host.status === "online" ? "Online" : "Offline";
  const cpu = host.cpu_bucket === null ? "CPU —" : `CPU ${host.cpu_bucket}/5`;
  const memory = host.mem_bucket === null ? "memory —" : `memory ${host.mem_bucket}/5`;
  const sessions = `${host.session_count} session${host.session_count === 1 ? "" : "s"}`;
  return `${presence} · ${cpu} · ${memory} · ${sessions}`;
}

export function HostStep({ hosts, selectedHostId, onSelect }: HostStepProps): React.JSX.Element {
  const ordered = [...hosts].sort(
    (left, right) =>
      Number(right.status === "online") - Number(left.status === "online") ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.intro}>
        <Text variant="title">Choose a host</Text>
        <Text color="mutedForeground">
          Pick the machine that will own this shell. Capacity meters are informational.
        </Text>
      </View>
      {ordered.map((host) => {
        const online = host.status === "online";
        const paired = Boolean(host.host_public_key);
        const detail = paired ? hostDetail(host) : `${hostDetail(host)} · pairing key unavailable`;
        return (
          <ChoiceRow
            accessibilityLabel={`Use host ${host.name}. ${detail}`}
            detail={detail}
            disabled={!online || !paired}
            icon="Server"
            key={host.id}
            onPress={() => onSelect(host)}
            selected={host.id === selectedHostId}
            statusTone={online ? "active" : "offline"}
            title={host.name}
          />
        );
      })}
      {ordered.length === 0 ? (
        <Text color="mutedForeground">No hosts are paired with this account yet.</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[3], padding: spacing[4], paddingBottom: spacing[8] },
  intro: { gap: spacing[2], paddingBottom: spacing[2] },
});
