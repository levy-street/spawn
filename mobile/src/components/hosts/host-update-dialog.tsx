import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { installCommandForHostOS } from "@/components/longtail/public-content";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getBaseUrl } from "@/data/api/config";
import type { HostOut } from "@/data/api/schemas/hosts";
import { useHostUpdatePolling, useUpdateHost } from "@/data/queries/hosts";
import { borderWidth, spacing, useTheme } from "@/theme";

const FALLBACK_ORIGIN = "https://spawnd.dev";

export interface HostUpdateDialogProps {
  host: HostOut;
  visible: boolean;
  onDismiss(): void;
  onNotNow?(): void;
  onUpdated?(): void;
}

export function HostUpdateDialog({
  host,
  visible,
  onDismiss,
  onNotNow,
  onUpdated,
}: HostUpdateDialogProps): React.JSX.Element | null {
  const theme = useTheme();
  const polling = useHostUpdatePolling(host, visible);
  const updateHost = useUpdateHost(host.id);
  const [origin, setOrigin] = useState(FALLBACK_ORIGIN);
  const [copied, setCopied] = useState(false);
  const currentHost = polling.data ?? host;
  const update = currentHost.update;
  const state = update?.state ?? "unknown";
  const installCommand = installCommandForHostOS(origin, currentHost.os);

  useEffect(() => {
    let active = true;
    void getBaseUrl().then(
      (baseUrl) => {
        if (active) setOrigin(new URL(baseUrl).origin);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!visible || state !== "current") return;
    onUpdated?.();
    onDismiss();
  }, [onDismiss, onUpdated, state, visible]);

  if (state === "current" || state === "unknown") return null;

  const close = () => {
    updateHost.reset();
    setCopied(false);
    onDismiss();
  };
  const notNow = () => {
    onNotNow?.();
    close();
  };
  const requestUpdate = () => updateHost.mutate();
  const command = (
    <View
      style={[
        styles.command,
        {
          backgroundColor: theme.colors.muted,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
        },
      ]}
    >
      <Text selectable variant="mono">
        {installCommand}
      </Text>
      <Button
        accessibilityLabel="Copy install command"
        onPress={() => {
          void Clipboard.setStringAsync(installCommand).then(() => setCopied(true));
        }}
        size="sm"
        variant="outline"
      >
        <Icon color="foreground" name={copied ? "Check" : "Copy"} size={spacing[4]} />
        {copied ? "Copied" : "Copy"}
      </Button>
    </View>
  );

  const error = updateHost.error?.message ?? (polling.isError ? polling.error.message : null);
  const title = `Update SPAWN D on ${currentHost.name}`;

  if (state === "updating") {
    return (
      <Dialog onDismiss={close} showCloseButton={false} title={title} visible={visible}>
        <View style={styles.updating}>
          <Spinner size={spacing[5]} />
          <Text color="mutedForeground">
            Updating… the daemon restarts itself; sessions keep running.
          </Text>
        </View>
      </Dialog>
    );
  }

  if (state === "failed") {
    return (
      <Dialog
        footer={
          <>
            <Button loading={updateHost.isPending} onPress={requestUpdate}>
              Try again
            </Button>
            <Button onPress={notNow} variant="outline">
              Close
            </Button>
          </>
        }
        onDismiss={close}
        showCloseButton={false}
        title={title}
        visible={visible}
      >
        <View style={styles.content}>
          <Text color="mutedForeground">
            The update did not complete: {update?.error ?? "unknown error"}. Run this on the
            machine:
          </Text>
          {command}
          {error ? (
            <Text accessibilityRole="alert" color="destructive" variant="caption">
              {error}
            </Text>
          ) : null}
        </View>
      </Dialog>
    );
  }

  if (state === "unsupported") {
    return (
      <Dialog
        footer={
          <Button onPress={notNow} variant="outline">
            Close
          </Button>
        }
        onDismiss={close}
        showCloseButton={false}
        title={title}
        visible={visible}
      >
        <View style={styles.content}>
          <Text color="mutedForeground">
            This daemon cannot update itself ({update?.error ?? "unsupported"}). Run this on the
            machine:
          </Text>
          {command}
        </View>
      </Dialog>
    );
  }

  if (currentHost.status !== "online") {
    return (
      <Dialog
        footer={
          <Button onPress={notNow} variant="outline">
            Close
          </Button>
        }
        onDismiss={close}
        showCloseButton={false}
        title={title}
        visible={visible}
      >
        <View style={styles.content}>
          <Text color="mutedForeground">
            This machine is offline. It updates itself the next time it connects.
          </Text>
        </View>
      </Dialog>
    );
  }

  return (
    <Dialog
      footer={
        <>
          <Button loading={updateHost.isPending} onPress={requestUpdate}>
            Update now
          </Button>
          <Button onPress={notNow} variant="outline">
            Not now
          </Button>
        </>
      }
      onDismiss={close}
      showCloseButton={false}
      title={title}
      visible={visible}
    >
      <View style={styles.content}>
        <Text color="mutedForeground">
          This machine is running an older SPAWN D daemon ({currentHost.version ?? "unknown"}).
          Update it to keep working with this version of the app. Running sessions are kept.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" color="destructive" variant="caption">
            {error}
          </Text>
        ) : null}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  command: {
    alignItems: "flex-start",
    borderWidth: borderWidth.hairline,
    gap: spacing[3],
    padding: spacing[3],
  },
  content: {
    gap: spacing[4],
    padding: spacing[4],
  },
  updating: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[4],
  },
});
