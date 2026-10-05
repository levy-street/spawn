import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ListGroup } from "@/components/ui/list-group";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { HostPinCapacity, HostPinsOut } from "@/data/api/schemas/trust";
import { spacing } from "@/theme";

export function hostPinCapacityWarning(capacity: HostPinCapacity | null): string | null {
  if (capacity === null || capacity.used < 28) return null;
  return `This host is close to its limit of approving devices (${capacity.used} of ${capacity.max}). Remove devices you no longer use under Access.`;
}

export function HostApprovingDevices({
  devices,
  hostPins,
}: {
  devices: readonly BrowserDeviceOut[];
  hostPins: HostPinsOut;
}): React.JSX.Element {
  const labels = new Map(devices.map((device) => [device.id, device.label ?? "Unnamed device"]));
  const warning = hostPinCapacityWarning(hostPins.capacity);
  const title =
    hostPins.capacity === null
      ? "Approving devices"
      : `Approving devices · ${hostPins.capacity.used} of ${hostPins.capacity.max}`;

  return (
    <View style={styles.approvingDevices} testID="host-approving-devices">
      <Text variant="label">{title}</Text>
      {warning ? (
        <Card style={styles.capacityWarning} testID="host-device-capacity-warning" variant="flat">
          <Icon color="warning" name="ShieldAlert" size={spacing[5]} />
          <Text color="mutedForeground" style={styles.capacityCopy}>
            {warning}
          </Text>
        </Card>
      ) : null}
      {hostPins.pins.length === 0 ? (
        <Text color="mutedForeground">No devices are approved for this host.</Text>
      ) : (
        <ListGroup openingRule>
          {hostPins.pins.map((pin) => (
            <ListRow
              key={pin.browser_device_id}
              shape="fullBleed"
              subtitle={pin.delivered ? "Approved for this host" : "Approval needs attention"}
              title={labels.get(pin.browser_device_id) ?? "Unknown device"}
              {...(pin.delivered
                ? {}
                : { trailing: <Badge variant="warning">Not delivered</Badge> })}
            />
          ))}
        </ListGroup>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  approvingDevices: {
    gap: spacing[3],
  },
  capacityCopy: {
    flex: 1,
  },
  capacityWarning: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
  },
});
