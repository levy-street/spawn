import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import { spacing } from "@/theme";

export interface BrowserDeviceRowProps {
  device: BrowserDeviceOut;
  fingerprint: string;
  current: boolean;
  trustedHostCount: number;
  canApprove: boolean;
  busy: boolean;
  onRename: (label: string | null) => void;
  onApprove: () => void;
  onRevoke: () => void;
}

export function BrowserDeviceRow({
  device,
  fingerprint,
  current,
  trustedHostCount,
  canApprove,
  busy,
  onRename,
  onApprove,
  onRevoke,
}: BrowserDeviceRowProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(device.label ?? "");

  return (
    <Card testID={`browser-device-${device.id}`} variant="flat">
      <View style={styles.titleLine}>
        <Text variant="label">{device.label ?? "Unnamed browser"}</Text>
        {current ? <Badge variant="info">this device</Badge> : null}
      </View>
      <Text color="mutedForeground" variant="caption">
        {trustedHostCount > 0
          ? `trusted · ${trustedHostCount} ${trustedHostCount === 1 ? "host" : "hosts"}`
          : "not trusted yet"}
      </Text>
      <Text color="mutedForeground" selectable variant="mono">
        {fingerprint}
      </Text>
      <Text color="mutedForeground" variant="caption">
        Added {new Date(device.created_at).toLocaleDateString()}
      </Text>

      {renaming ? (
        <View style={styles.rename}>
          <Field label="Device name">
            <Input
              autoFocus
              editable={!busy}
              maxLength={64}
              onChangeText={setLabel}
              placeholder="e.g. Work laptop, Pixel phone"
              purpose="name"
              value={label}
            />
          </Field>
          <View style={styles.actions}>
            <Button
              disabled={busy}
              onPress={() => {
                onRename(label.trim() || null);
                setRenaming(false);
              }}
              size="sm"
            >
              Save name
            </Button>
            <Button
              disabled={busy}
              onPress={() => setRenaming(false)}
              size="sm"
              variant="secondary"
            >
              Cancel rename
            </Button>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button disabled={busy} onPress={() => setRenaming(true)} size="sm" variant="outline">
            Rename
          </Button>
          {canApprove ? (
            <Button disabled={busy} onPress={onApprove} size="sm" variant="outline">
              Approve…
            </Button>
          ) : null}
          <Button disabled={busy} onPress={onRevoke} size="sm" variant="ghost">
            Revoke
          </Button>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  rename: {
    gap: spacing[2],
    marginTop: spacing[3],
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
