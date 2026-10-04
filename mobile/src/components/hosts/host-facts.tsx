import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import {
  formatBytes,
  formatHostPlatform,
  type HostCapacitySpec,
  possessedLabel,
} from "@/components/hosts/host-model";
import { HostUpdateChip } from "@/components/hosts/host-update-status";
import { ListGroup } from "@/components/ui/list-group";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { spacing } from "@/theme";
import { sizing } from "@/theme/sizing";

export function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <View style={styles.fact}>
      <Text color="mutedForeground" style={styles.factLabel} variant="caption">
        {label}
      </Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text selectable={mono} style={styles.factValue} variant={mono ? "mono" : "body"}>
          {value}
        </Text>
      ) : (
        <View style={styles.factValue}>{value}</View>
      )}
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

/** "10 cores · 12 threads", or just the threads when the host gave no split. */
export function formatHostCores(
  spec: Pick<HostCapacitySpec, "cpu_cores" | "cpu_physical_cores">,
): string {
  const threads = spec.cpu_cores;
  const physical = spec.cpu_physical_cores ?? null;
  if (physical === null || physical === threads) {
    return `${threads} ${threads === 1 ? "core" : "cores"}`;
  }
  return `${physical} ${physical === 1 ? "core" : "cores"} · ${threads} threads`;
}

/**
 * What the machine is — its system, CPU, cores, memory and GPU — then the
 * SPAWN D it runs and the day it was possessed, in the browser's order and
 * words (the CPU and GPU named as the gauges above them are). A spec the host
 * sent over this device's own channel is preferred to the one it registered
 * with, which can be a restart old.
 */
export function HostMachineFacts({
  host,
  liveSpec = null,
  onOpenUpdate,
}: {
  host: HostOut;
  liveSpec?: HostCapacitySpec | null;
  /** Opens the update dialog from the update chip, as the browser's badge does. */
  onOpenUpdate?(): void;
}) {
  const cores = liveSpec?.cpu_cores ?? host.cpu_cores;
  const physical = liveSpec ? (liveSpec.cpu_physical_cores ?? null) : host.cpu_physical_cores;
  const model = (liveSpec ? liveSpec.cpu_model : host.cpu_model)?.trim() || null;
  const memory = liveSpec?.memory_bytes ?? host.memory_bytes;
  const gpu = (liveSpec ? liveSpec.gpu : host.gpu)?.trim() || null;
  const possessed = possessedLabel(host.created_at);
  const update = host.update?.state === "available" || host.update?.state === "updating";
  return (
    <View style={styles.section} testID="host-machine-facts">
      <SectionHeader style={styles.sectionHeader} title="Machine" />
      <ListGroup>
        <Fact label="System" value={formatHostPlatform(host)} />
        {model ? <Fact label="CPU" value={model} /> : null}
        {cores === null ? null : (
          <Fact
            label="Cores"
            value={formatHostCores({ cpu_cores: cores, cpu_physical_cores: physical })}
          />
        )}
        {memory === null ? null : <Fact label="Memory" value={formatBytes(memory)} />}
        {gpu ? <Fact label="GPU" value={gpu} /> : null}
        <Fact
          label="SPAWN D"
          value={
            update ? (
              <View style={styles.versionRow}>
                <Text>{host.version ?? "unknown"}</Text>
                <HostUpdateChip host={host} {...(onOpenUpdate ? { onPress: onOpenUpdate } : {})} />
              </View>
            ) : (
              (host.version ?? "unknown")
            )
          }
        />
      </ListGroup>
      {possessed ? (
        <Text color="mutedForeground" style={styles.footnote} variant="caption">
          {possessed}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Who the host is to this device: the kind of key it was possessed with, and
 * that key's fingerprint, derived here rather than taken from the server. The
 * raw key itself is noise to a person, so it is not shown.
 */
export function HostIdentityFacts({ host }: { host: HostOut }) {
  return (
    <View style={styles.section} testID="host-identity-facts">
      <SectionHeader style={styles.sectionHeader} title="Identity" />
      <ListGroup>
        <Fact
          label="Host identity"
          value={host.host_key_algorithm === "ed25519" ? "ed25519" : "legacy unpaired"}
        />
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
  footnote: {
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: spacing[2],
  },
  section: {
    gap: spacing[0],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
  versionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
