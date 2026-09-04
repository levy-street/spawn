import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { UpdateOverlay } from "@/components/release/update-overlay";
import type { Release } from "@/data/api/schemas/release";
import { useRelease } from "@/data/queries/release";
import { subscribeProtocolRequired } from "@/data/realtime/socket";
import {
  clientMobileTree,
  decideMobileUpdate,
  type MobileUpdatesClient,
  mobileUpdates,
} from "@/lib/updates";

const RELEASE_CHECK_MS = 15 * 60 * 1_000;
const SOFT_SNOOZE_MS = 30 * 60 * 1_000;
/**
 * The store listing, once there is one.
 *
 * Null until then, exactly as the browser has it
 * (`web/src/lib/platform.ts`): neither store resolves yet, and a button to
 * `apps.apple.com/` is a button to the storefront's front page — which, on a
 * screen the person cannot leave, is a trap rather than a way out. Filling
 * this in is the only change needed to turn the words back into a button.
 */
const APP_STORE_URL: string | null = null;

// "apply" is a bundle already on the phone, waiting to be swapped in; "store"
// is a build only a reinstall can move off.
type UpdatePrompt = { kind: "apply" | "store"; hard: boolean };

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
  /**
   * A required update is running right now.
   *
   * Without this the hard path fetched a bundle in silence — seconds of
   * nothing on a screen whose sockets had just been refused — and only spoke
   * once it was ready to swap. The work is not optional, so it takes the
   * screen while it happens.
   */
  const [forcedBusy, setForcedBusy] = useState(false);
  /**
   * The swap itself, from the moment Update now is pressed until the new
   * bundle takes over. It is usually instant — the bundle is already on the
   * phone by then — but a phone that has just woken can take a beat, and a
   * button that answers a press with nothing invites a second one.
   */
  const [applying, setApplying] = useState(false);
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
      if (hard && mountedRef.current) setForcedBusy(true);
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
        present({ kind: "apply", hard: becameHard });
      } catch {
        const becameHard = hard || pendingHardRef.current;
        pendingHardRef.current = false;
        if (becameHard) present({ kind: "store", hard: true });
      } finally {
        checkingRef.current = false;
        if (mountedRef.current) setForcedBusy(false);
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

  /**
   * Takes the update in place.
   *
   * `reloadAsync` swaps the running bundle for the one already downloaded, so
   * nobody has to leave the app, kill it, and come back — which is what "please
   * restart" used to be asking for. If it fails the button comes back rather
   * than sitting spinning: the bundle is still on the phone, and pressing again
   * is the right next move.
   */
  const applyUpdate = useCallback(() => {
    if (applying) return;
    setApplying(true);
    void updates.reloadAsync().catch(() => {
      if (mountedRef.current) setApplying(false);
    });
  }, [applying, updates]);

  if (!updates.isEnabled) return null;

  // A required update in flight owns the screen. Everything else in the app is
  // already unusable — the server refused this build at the handshake — so a
  // dismissible notice over it would be a lie about what still works.
  if (forcedBusy) {
    return (
      <UpdateOverlay
        body="This version can no longer talk to the server. Getting the new one now."
        busy
        title="SPAWN D needs to update"
      />
    );
  }

  const later = () => {
    snoozeUntilRef.current = now() + SOFT_SNOOZE_MS;
    setPrompt(null);
  };

  if (prompt?.kind === "store") {
    // A hard prompt is normally undismissable, because the app really cannot
    // go on. That only holds while there is somewhere to send the person: with
    // no listing to update from, refusing to let them off this screen leaves
    // them holding a phone that can do nothing at all. Say what happened, and
    // let them out.
    const storeUrl = APP_STORE_URL;
    const stranded = storeUrl === null;
    return (
      <UpdateOverlay
        body={
          stranded
            ? "This version of SPAWN D no longer works with the server. It cannot update itself yet — SPAWN D is not in the App Store — so reinstall it from wherever you installed it."
            : "This version of SPAWN D no longer works with the server. Update it from the App Store."
        }
        {...(stranded
          ? { primary: { label: "Close", onPress: later } }
          : {
              primary: { label: "Open App Store", onPress: () => void Linking.openURL(storeUrl) },
              ...(prompt.hard ? {} : { secondary: { label: "Later", onPress: later } }),
            })}
        title="Update SPAWN D"
      />
    );
  }

  if (prompt?.kind !== "apply") return null;

  // Hard and soft differ in what they say and whether Later exists, not in
  // what the button does: the bundle is already on the phone either way, and
  // pressing Update now swaps to it without anyone leaving the app.
  return (
    <UpdateOverlay
      body={
        prompt.hard
          ? "This version can no longer talk to the server. The new one is downloaded and ready."
          : "It is already downloaded. Updating takes a moment, and your sessions keep running."
      }
      primary={{ label: "Update now", loading: applying, onPress: applyUpdate }}
      {...(prompt.hard ? {} : { secondary: { label: "Later", onPress: later } })}
      title={prompt.hard ? "SPAWN D needs to update" : "A new SPAWN D is ready"}
    />
  );
}
