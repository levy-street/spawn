import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsBlock } from "@/components/settings/settings-block";
import { markSettingsRow } from "@/components/settings/settings-grouped";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
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

/** A phone or a browser, or something that says it is one. */
function deviceGlyph(label: string | null): "Smartphone" | "Monitor" {
  return /iphone|android|pixel|phone|ipad|tablet/i.test(label ?? "") ? "Smartphone" : "Monitor";
}

/**
 * One device signed in as this account: what it is called, whether any host
 * trusts it, the fingerprint that proves which one it is, and what can be done
 * about it. Drawn as an entry in the page's list, hairlines and all, rather
 * than a run of loose paragraphs — nine of those with no rule between them is
 * what made this page unreadable.
 */
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
  const trusted = trustedHostCount > 0;

  return (
    <SettingsBlock testID={`browser-device-${device.id}`}>
      <View style={styles.row}>
        <View style={styles.glyph}>
          <Icon color="mutedForeground" name={deviceGlyph(device.label)} size={spacing[5]} />
        </View>
        <View style={styles.copy}>
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={styles.title} variant="label">
              {device.label ?? "Unnamed browser"}
            </Text>
            {current ? <Badge variant="info">This device</Badge> : null}
          </View>
          <View style={styles.statusLine}>
            <StatusDot
              accessibilityLabel={trusted ? "Trusted" : "Not trusted"}
              pulse={false}
              tone={trusted ? "active" : "idle"}
            />
            <Text color={trusted ? "mutedForeground" : "warning"} variant="caption">
              {trusted
                ? `Trusted by ${trustedHostCount} ${trustedHostCount === 1 ? "host" : "hosts"}`
                : "Not trusted by any host yet"}
            </Text>
          </View>
          <Text color="mutedForeground" selectable variant="mono">
            {fingerprint}
          </Text>
          <Text color="mutedForeground" variant="caption">
            Added {new Date(device.created_at).toLocaleDateString()}
          </Text>
        </View>
      </View>

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
    </SettingsBlock>
  );
}

// A section groups these with the rows around them and draws the hairlines.
markSettingsRow(BrowserDeviceRow);

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  copy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  glyph: {
    alignItems: "center",
    height: spacing[6],
    justifyContent: "center",
    width: spacing[6],
  },
  rename: {
    gap: spacing[2],
  },
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
  },
  statusLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
