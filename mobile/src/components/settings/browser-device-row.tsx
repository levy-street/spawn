import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { relativeSeen } from "@/components/hosts/host-model";
import { SettingsBlock } from "@/components/settings/settings-block";
import { markSettingsRow } from "@/components/settings/settings-grouped";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import { spacing } from "@/theme";

const STALE_DEVICE_MS = 60 * 24 * 60 * 60 * 1_000;

function seenAt(device: BrowserDeviceOut): string {
  return device.last_seen_at ?? device.created_at;
}

export function browserDeviceSeenLabel(device: BrowserDeviceOut, now = Date.now()): string {
  return `Seen ${relativeSeen(seenAt(device), now)}`;
}

export function staleBrowserDeviceLabel(device: BrowserDeviceOut, now = Date.now()): string | null {
  const timestamp = Date.parse(seenAt(device));
  if (!Number.isFinite(timestamp) || now - timestamp <= STALE_DEVICE_MS) return null;
  return `Not seen since ${new Date(timestamp).toLocaleDateString()}`;
}

/** Live roster order: genuinely seen devices first, newest sighting first. */
export function sortBrowserDevicesByLastSeen(
  devices: readonly BrowserDeviceOut[],
): BrowserDeviceOut[] {
  return [...devices].sort((left, right) => {
    const leftSeen =
      left.last_seen_at == null ? Number.NEGATIVE_INFINITY : Date.parse(left.last_seen_at);
    const rightSeen =
      right.last_seen_at == null ? Number.NEGATIVE_INFINITY : Date.parse(right.last_seen_at);
    const bySeen =
      (Number.isFinite(rightSeen) ? rightSeen : Number.NEGATIVE_INFINITY) -
      (Number.isFinite(leftSeen) ? leftSeen : Number.NEGATIVE_INFINITY);
    if (bySeen !== 0) return bySeen;
    return Date.parse(right.created_at) - Date.parse(left.created_at);
  });
}

export interface BrowserDeviceRowProps {
  device: BrowserDeviceOut;
  current: boolean;
  trustedHostCount: number;
  canApprove: boolean;
  busy: boolean;
  onRename: (label: string | null) => void;
  onApprove: () => void;
  onRemove: () => void;
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
  current,
  trustedHostCount,
  canApprove,
  busy,
  onRename,
  onApprove,
  onRemove,
}: BrowserDeviceRowProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [label, setLabel] = useState(device.label ?? "");
  const trusted = trustedHostCount > 0;
  const staleLabel = staleBrowserDeviceLabel(device);
  const deviceName = device.label ?? "Unnamed device";

  return (
    <SettingsBlock testID={`browser-device-${device.id}`}>
      <View style={styles.row}>
        <View style={styles.glyph}>
          <Icon color="mutedForeground" name={deviceGlyph(device.label)} size={spacing[5]} />
        </View>
        <View style={styles.copy}>
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={styles.title} variant="label">
              {deviceName}
            </Text>
            {current ? <Badge variant="info">This device</Badge> : null}
            {!trusted ? <Badge variant="warning">Waiting for approval</Badge> : null}
          </View>
          {trusted ? (
            <View style={styles.statusLine}>
              <StatusDot accessibilityLabel="Approved" pulse={false} tone="active" />
              <Text color="mutedForeground" variant="caption">
                Approved for {trustedHostCount} {trustedHostCount === 1 ? "host" : "hosts"}
              </Text>
            </View>
          ) : null}
          <Text color="mutedForeground" variant="caption">
            {browserDeviceSeenLabel(device)}
          </Text>
          {staleLabel ? <Badge variant="warning">{staleLabel}</Badge> : null}
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
        <View style={styles.rowActions}>
          {canApprove ? (
            <Button disabled={busy} onPress={onApprove} size="sm">
              Approve…
            </Button>
          ) : null}
          <IconButton
            accessibilityLabel={`Options for ${deviceName}`}
            disabled={busy}
            icon="Ellipsis"
            onPress={() => setActionsVisible(true)}
            size="sm"
            variant="ghost"
          />
        </View>
      )}

      <ActionSheet
        actions={[
          {
            id: "rename",
            label: "Rename",
            icon: <Icon color="mutedForeground" name="Pencil" />,
            onPress: () => setRenaming(true),
          },
          {
            id: "remove",
            label: "Remove",
            destructive: true,
            icon: <Icon color="destructive" name="Trash2" />,
            onPress: onRemove,
          },
        ]}
        onDismiss={() => setActionsVisible(false)}
        title={deviceName}
        visible={actionsVisible}
      />
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
  rowActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    justifyContent: "flex-end",
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
