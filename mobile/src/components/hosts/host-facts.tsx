import { StyleSheet, View } from "react-native";
import { hostConnectionLabel, pluralize } from "@/components/hosts/host-model";
import { Divider } from "@/components/ui/divider";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { spacing } from "@/theme";

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text color="mutedForeground" style={styles.factLabel} variant="caption">
        {label}
      </Text>
      <Text selectable={mono} style={styles.factValue} variant={mono ? "mono" : "body"}>
        {value}
      </Text>
    </View>
  );
}

export function HostFacts({ host }: { host: HostOut }) {
  return (
    <View style={styles.section} testID="host-facts">
      <Text accessibilityRole="header" variant="label" weight="semibold">
        Details
      </Text>
      <View style={styles.facts}>
        <Fact label="System" value={`${host.os ?? "?"}/${host.arch ?? "?"}`} />
        <Divider />
        <Fact label="Daemon" value={host.version ?? "unknown"} />
        <Divider />
        <Fact label="Sessions" value={pluralize(host.session_count, "session")} />
        <Divider />
        <Fact label="Connection" value={hostConnectionLabel(host)} />
        <Divider />
        <Fact
          label="Host identity"
          value={host.host_key_algorithm === "ed25519" ? "ed25519" : "legacy unpaired"}
        />
        <Divider />
        <Fact label="Public key" mono value={host.host_public_key ?? "not pinned"} />
        <Divider />
        <Fact label="Fingerprint" mono value={host.host_key_fingerprint ?? "not pinned"} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fact: {
    flexDirection: "row",
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  factLabel: {
    width: spacing[24],
  },
  factValue: {
    flex: 1,
  },
  facts: {
    gap: spacing[0],
  },
  section: {
    gap: spacing[2],
  },
});
