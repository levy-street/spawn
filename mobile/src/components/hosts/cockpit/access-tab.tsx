import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { HostApprovingDevices } from "@/components/hosts/host-approving-devices";
import { HostIdentityFacts } from "@/components/hosts/host-facts";
import { errorMessage } from "@/components/hosts/host-model";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ListGroup } from "@/components/ui/list-group";
import { ListRow } from "@/components/ui/list-row";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { HostPinsOut } from "@/data/api/schemas/trust";
import { haptics } from "@/lib/haptics";
import { spacing, useTheme } from "@/theme";

export interface AccessTabProps {
  host: HostOut;
  hostPins: {
    data: HostPinsOut | null | undefined;
    error: unknown;
    isPending: boolean;
    retry(): void;
  };
  browserDevices: readonly BrowserDeviceOut[];
  refreshing: boolean;
  onRefresh(): void;
  onManageDevices(): void;
}

/**
 * Who this host lets in: the identity it was possessed with, and the devices
 * that have approved it — the host page's trust half, moved under its own tab.
 */
export function AccessTab({
  host,
  hostPins,
  browserDevices,
  refreshing,
  onRefresh,
  onManageDevices,
}: AccessTabProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={refreshing}
          tintColor={theme.colors.mutedForeground}
        />
      }
      testID="host-access-tab"
    >
      <HostIdentityFacts host={host} />
      {hostPins.data ? (
        <HostApprovingDevices devices={browserDevices} hostPins={hostPins.data} />
      ) : hostPins.isPending ? (
        <View style={styles.row}>
          <Spinner label="Loading approving devices" />
          <Text color="mutedForeground">Loading approving devices…</Text>
        </View>
      ) : hostPins.error ? (
        <View style={styles.errorBlock}>
          <Text accessibilityRole="alert" color="destructive">
            Failed to load approving devices: {errorMessage(hostPins.error)}
          </Text>
          <Button onPress={hostPins.retry} size="sm" variant="outline">
            Retry
          </Button>
        </View>
      ) : null}
      <ListGroup openingRule>
        <ListRow
          leading={<Icon color="mutedForeground" name="MonitorSmartphone" size={spacing[5]} />}
          onPress={() => {
            haptics.selection();
            onManageDevices();
          }}
          shape="fullBleed"
          subtitle="Approve, rename or revoke your devices"
          title="Manage devices"
          trailing={<Icon color="mutedForeground" name="ChevronRight" />}
        />
      </ListGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[8],
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
  errorBlock: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
