import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import type { Release } from "@/data/api/schemas/release";
import { useRelease } from "@/data/queries/release";
import { subscribeProtocolRequired } from "@/data/realtime/socket";
import {
  clientMobileTree,
  decideMobileUpdate,
  type MobileUpdatesClient,
  mobileUpdates,
} from "@/lib/updates";
import { spacing } from "@/theme";

const RELEASE_CHECK_MS = 15 * 60 * 1_000;
const SOFT_SNOOZE_MS = 30 * 60 * 1_000;
/**
 * The store listing, once there is one.
 *
 * Null until then, exactly as the browser has it
 * (`web/src/lib/platform.ts`): neither store resolves yet, and a button to
 * `apps.apple.com/` is a button to the storefront's front page — which, in a
 * dialog the person cannot dismiss, is a trap rather than a way out. Filling
 * this in is the only change needed to turn the words back into a button.
 */
const APP_STORE_URL: string | null = null;

type UpdatePrompt = { kind: "restart" | "store"; hard: boolean };

export interface ReleaseWatcherProps {
  updates?: MobileUpdatesClient;
  now?: () => number;
}

export function ReleaseWatcher({
  updates = mobileUpdates,
  now = Date.now,
}: ReleaseWatcherProps): React.JSX.Element | null {
  const release = useRelease(false);
  const refetchRef = useRef(release.refetch);
  const mountedRef = useRef(true);
  const checkingRef = useRef(false);
  const pendingHardRef = useRef(false);
  const snoozeUntilRef = useRef(0);
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null);
  refetchRef.current = release.refetch;

  const present = useCallback((next: UpdatePrompt) => {
    if (!mountedRef.current) return;
    setPrompt((current) => {
      if (current?.hard) return current;
      return next;
    });
  }, []);

  const check = useCallback(
    async (hard: boolean) => {
      if (!updates.isEnabled) return;
      if (!hard && now() < snoozeUntilRef.current) return;
      if (checkingRef.current) {
        pendingHardRef.current ||= hard;
        return;
      }

      checkingRef.current = true;
      pendingHardRef.current = hard;
      try {
        const result = await refetchRef.current();
        const currentHard = pendingHardRef.current;
        pendingHardRef.current = false;
        const currentRelease: Release | undefined = result.data;
        const decision = currentRelease
          ? decideMobileUpdate({
              clientTree: clientMobileTree(),
              serverTree: currentRelease.mobile.tree,
              clientRuntime: updates.runtimeVersion,
              serverRuntime: currentRelease.mobile.runtime_version,
              hard: currentHard,
            })
          : currentHard
            ? "check-ota"
            : "none";

        if (decision === "none") return;
        if (decision === "store") {
          present({ kind: "store", hard: currentHard });
          return;
        }

        const available = await updates.checkForUpdateAsync();
        const becameHard = currentHard || pendingHardRef.current;
        pendingHardRef.current = false;
        if (!available) {
          if (becameHard) present({ kind: "store", hard: true });
          return;
        }
        await updates.fetchUpdateAsync();
        present({ kind: "restart", hard: becameHard });
      } catch {
        const becameHard = hard || pendingHardRef.current;
        pendingHardRef.current = false;
        if (becameHard) present({ kind: "store", hard: true });
      } finally {
        checkingRef.current = false;
      }
    },
    [now, present, updates],
  );

  useEffect(() => {
    mountedRef.current = true;
    void check(false);
    const interval = setInterval(() => void check(false), RELEASE_CHECK_MS);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void check(false);
    });
    const unsubscribeProtocol = subscribeProtocolRequired(() => void check(true));
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      appState.remove();
      unsubscribeProtocol();
    };
  }, [check]);

  if (!updates.isEnabled) return null;

  const later = () => {
    snoozeUntilRef.current = now() + SOFT_SNOOZE_MS;
    setPrompt(null);
  };

  if (prompt?.kind === "store") {
    // A hard prompt is normally undismissable, because the app really cannot
    // go on. That only holds while there is somewhere to send the person: with
    // no listing to update from, refusing to close the dialog leaves them
    // holding a phone that can do nothing at all. Say what happened, and let
    // them out.
    const storeUrl = APP_STORE_URL;
    const stranded = storeUrl === null;
    return (
      <Dialog
        footer={
          <>
            {storeUrl === null ? null : (
              <Button onPress={() => void Linking.openURL(storeUrl)}>Open App Store</Button>
            )}
            {stranded ? (
              <Button onPress={later}>Close</Button>
            ) : prompt.hard ? null : (
              <Button onPress={later} variant="outline">
                Later
              </Button>
            )}
          </>
        }
        onDismiss={() => undefined}
        showCloseButton={false}
        title="Update SPAWN D"
        visible
      >
        <View style={styles.content}>
          <Text color="mutedForeground">
            {stranded
              ? "This version of SPAWN D no longer works with the server. It cannot update itself yet — SPAWN D is not in the App Store — so reinstall it from wherever you installed it."
              : "This version of SPAWN D no longer works with the server. Update it from the App Store."}
          </Text>
        </View>
      </Dialog>
    );
  }

  return (
    <Dialog
      footer={
        <>
          <Button onPress={() => void updates.reloadAsync()}>Restart now</Button>
          {prompt?.hard ? null : (
            <Button onPress={later} variant="outline">
              Later
            </Button>
          )}
        </>
      }
      onDismiss={() => undefined}
      showCloseButton={false}
      title="SPAWN D has been updated"
      visible={prompt?.kind === "restart"}
    >
      <View style={styles.content}>
        <Text color="mutedForeground">Restart to pick up the new version.</Text>
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing[4],
  },
});
