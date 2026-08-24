import { StyleSheet, View } from "react-native";
import { hostConnectionLabel, pluralize } from "@/components/hosts/host-model";
import { ListGroup } from "@/components/ui/list-group";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { spacing } from "@/theme";
import { sizing } from "@/theme/sizing";

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

// The server never sends a fingerprint next to the key it vouches for
// (mesh B5) — display it the same way it is verified: derived locally.
function hostFingerprint(publicKeyWire: string | null): string {
  if (publicKeyWire === null) return "not pinned";
  try {
    return formatHostFingerprint(publicKeyWire);
  } catch {
    return "invalid key";
  }
}

export function HostFacts({ host }: { host: HostOut }) {
  return (
    <View style={styles.section} testID="host-facts">
      <SectionHeader style={styles.sectionHeader} title="Details" />
      <ListGroup>
        <Fact label="System" value={`${host.os ?? "?"}/${host.arch ?? "?"}`} />
        <Fact label="Daemon" value={host.version ?? "unknown"} />
        <Fact label="Sessions" value={pluralize(host.session_count, "session")} />
        <Fact label="Connection" value={hostConnectionLabel(host)} />
        <Fact
          label="Host identity"
          value={host.host_key_algorithm === "ed25519" ? "ed25519" : "legacy unpaired"}
        />
        <Fact label="Public key" mono value={host.host_public_key ?? "not pinned"} />
        <Fact label="Fingerprint" mono value={hostFingerprint(host.host_public_key)} />
      </ListGroup>
    </View>
  );
}

const styles = StyleSheet.create({
  fact: {
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: sizing.screen.gutter,
    paddingVertical: spacing[3],
  },
  factLabel: {
    width: spacing[24],
  },
  factValue: {
    flex: 1,
  },
  section: {
    gap: spacing[0],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
});
