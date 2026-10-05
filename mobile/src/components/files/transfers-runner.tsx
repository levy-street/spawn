import { useQueryClient } from "@tanstack/react-query";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useMemo, useRef } from "react";
import { AppState, StyleSheet, View } from "react-native";
import {
  interruptedNotice,
  PAUSED_DETAIL,
  PAUSED_TITLE,
  RESUME,
  RESUME_DETAIL,
  sentNotice,
  TRANSFERS_TITLE,
  transferFailedSummary,
  uploadedNotice,
} from "@/components/files/transfer-copy";
import { createTransferEngine, type TransferEngine } from "@/components/files/transfer-engine";
import type { TransferChannels } from "@/components/files/transfer-pool";
import { createTransferChannels } from "@/components/files/transfer-pool";
import { openLocalFileSource, releaseLocalCopy } from "@/components/files/upload-source";
import { useToast } from "@/components/ui/toast";
import { qk } from "@/data/queryKeys";
import {
  hostsInUse,
  isSettledBatch,
  type TransferBatch,
  type TransferHost,
  useTransfersStore,
} from "@/data/stores/transfers";
import { subscribeDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";

const KEEP_AWAKE_TAG = "spawn-host-transfers";
/** A folder on screen is read again at most this often while files land in it. */
const LISTING_REFRESH_MS = 2_000;

let backgroundEpoch = 0;

function appActive(): boolean {
  return AppState.currentState !== "background";
}

/** The picker's copies of the files of batches being forgotten. */
export function releaseBatchCopies(batches: readonly TransferBatch[]): void {
  for (const batch of batches) {
    for (const item of batch.items) {
      if (item.source.kind === "local") releaseLocalCopy(item.source.uri);
    }
  }
}

/** Clears every batch with nothing left to run, and the phone's copies of its files. */
export function clearFinishedTransfers(): void {
  releaseBatchCopies(useTransfersStore.getState().clearFinished());
}

/**
 * Runs the transfer queue for the whole signed-in app: mounted once, beside
 * the navigator, so a transfer goes on while the person moves between
 * screens. It holds a channel to each host the queue needs — one per host,
 * apart from whatever a screen holds for browsing — and only while there is a
 * file to move; keeps the screen awake while one is moving, because a phone
 * that locks takes SPAWN D off the screen; and says when a batch is done.
 *
 * Signing out or switching account forgets the queue and stops what is
 * running: the queue is the account's, and nothing of it is kept.
 */
export function TransfersRunner(): React.JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();
  const batches = useTransfersStore((state) => state.batches);
  const paused = useTransfersStore((state) => state.paused);
  const pausedBy = useTransfersStore((state) => state.pausedBy);
  const running = useTransfersStore((state) =>
    state.batches.some((batch) => batch.items.some((item) => item.state === "running")),
  );
  const hosts = useMemo(() => hostsInUse({ batches, paused }), [batches, paused]);
  const channels = useRef<TransferChannels | null>(null);
  channels.current ??= createTransferChannels();
  const engine = useRef<TransferEngine | null>(null);
  const refreshedAt = useRef(new Map<string, number>());
  const notify = useRef<(batchId: string, itemId: string) => void>(() => undefined);

  notify.current = (batchId, itemId) => {
    const state = useTransfersStore.getState();
    const batch = state.batches.find((candidate) => candidate.id === batchId);
    const item = batch?.items.find((candidate) => candidate.id === itemId);
    if (!batch || !item) return;
    // Nothing reads a file that arrived, or was left on purpose, again. A
    // failed or cancelled one keeps its copy for Retry until it is cleared.
    if (item.state === "done" || item.state === "skipped") {
      if (item.source.kind === "local") releaseLocalCopy(item.source.uri);
    }
    if (item.state === "done" && item.relative.length === 1) {
      // The folder the files land in, if a screen has it open, shows them arriving.
      const key = `${batch.destination.id}\n${batch.destDir}`;
      const at = Date.now();
      if (at - (refreshedAt.current.get(key) ?? 0) >= LISTING_REFRESH_MS) {
        refreshedAt.current.set(key, at);
        void queryClient.invalidateQueries({
          queryKey: qk.hostFiles(batch.destination.id, batch.destDir),
          exact: true,
        });
      }
    }
    if (!isSettledBatch(batch) || batch.notified) return;
    state.patchBatch(batch.id, { notified: true });
    void queryClient.invalidateQueries({ queryKey: qk.hostFilesForHost(batch.destination.id) });
    const failed = batch.items.filter((candidate) => candidate.state === "failed").length;
    if (failed > 0) {
      toast.error(transferFailedSummary(failed, batch.kind), {
        actions: [{ label: TRANSFERS_TITLE, onPress: () => state.showSheet() }],
      });
      return;
    }
    // What was picked and arrived, under the name it landed as.
    const arrived = batch.items.filter(
      (candidate) => candidate.relative.length === 1 && candidate.state === "done",
    );
    if (arrived.length === 0) return;
    const names = arrived.map((candidate) => candidate.savedAs ?? candidate.name);
    toast.success(
      batch.kind === "upload"
        ? uploadedNotice(names, batch.destLabel, batch.destination.name)
        : sentNotice(names, batch.destLabel, batch.destination.name),
    );
  };

  useEffect(() => {
    const pool = channels.current;
    if (!pool) return;
    const created = createTransferEngine({
      pool: pool.pool,
      openLocal: (uri) => openLocalFileSource(uri),
      backgroundEpoch: () => backgroundEpoch,
      appActive,
      onItemSettled: (batchId, itemId) => notify.current(batchId, itemId),
    });
    engine.current = created;
    created.kick();
    const forget = () => releaseBatchCopies(useTransfersStore.getState().reset());
    const unsubscribeIdentity = subscribeDeviceIdentityAccount(forget);
    return () => {
      unsubscribeIdentity();
      created.dispose();
      engine.current = null;
      forget();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") backgroundEpoch += 1;
      else if (next === "active") engine.current?.kick();
    });
    return () => subscription.remove();
  }, []);

  // Wherever the person is, the pause is said once, with Resume on it — why it
  // stopped, the background or a connection that went — and it goes when the
  // queue moves again.
  useEffect(() => {
    if (!paused) return;
    const lostTouch = pausedBy?.cause === "lost-touch" ? pausedBy : null;
    const id = toast.show(lostTouch ? interruptedNotice(lostTouch) : PAUSED_TITLE, {
      detail: lostTouch ? RESUME_DETAIL : PAUSED_DETAIL,
      persistent: true,
      actions: [
        { label: RESUME, variant: "primary", onPress: () => useTransfersStore.getState().resume() },
        { label: TRANSFERS_TITLE, onPress: () => useTransfersStore.getState().showSheet() },
      ],
    });
    return () => toast.dismiss(id);
  }, [paused, pausedBy, toast]);

  useEffect(() => {
    if (!running) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    };
  }, [running]);

  return (
    <View pointerEvents="none" style={styles.container}>
      {hosts.map((host) => (
        <TransferChannel
          channels={channels.current}
          host={host}
          key={`${host.id}:${host.publicKey}`}
        />
      ))}
    </View>
  );
}

/** One host's channel for the queue, held for as long as this is mounted. */
function TransferChannel({
  channels,
  host,
}: {
  channels: TransferChannels | null;
  host: TransferHost;
}): React.JSX.Element {
  useEffect(() => () => channels?.detach(host.id), [channels, host.id]);
  return (
    <HostTransportSurface
      hostId={host.id}
      hostIdentityPublicKey={host.publicKey}
      onError={(error) => channels?.setError(host.id, error)}
      onStateChange={(state) => channels?.setState(host.id, state)}
      onTransport={(transport) => channels?.attach(host.id, transport)}
    />
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", left: 0, top: 0 },
});
