import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { formatFileSize } from "@/components/files/format";
import {
  CLEAR_FINISHED,
  conflictApplyToRest,
  conflictDecisionLabel,
  conflictQuestion,
  ITEM_DONE,
  ITEM_FINISHING,
  ITEM_MERGED,
  ITEM_REPLACED,
  ITEM_SKIPPED,
  ITEM_VERIFIED,
  ITEM_WAITING,
  interruptedNotice,
  KEEP_OPEN,
  PAUSED_DETAIL,
  PAUSED_TITLE,
  PREPARING,
  preparingLabel,
  queuedNotice,
  RESUME,
  RESUME_DETAIL,
  savedAsLabel,
  TRANSFER_CANCELLED,
  TRANSFERS_TITLE,
  transferDoneSummary,
  transferFailedSummary,
  transferProgress,
  transferTitle,
} from "@/components/files/transfer-copy";
import {
  conflictChoices,
  estimateSeconds,
  worthEstimating,
} from "@/components/files/transfer-plan";
import { clearFinishedTransfers } from "@/components/files/transfers-runner";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Sheet, SheetHeader, SheetScrollView } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import {
  batchPercent,
  batchProgress,
  isSettledBatch,
  runnableItem,
  type TransferBatch,
  type TransferItem,
  useTransfersStore,
} from "@/data/stores/transfers";
import { borderWidth, spacing, useTheme } from "@/theme";

/** Past this many items a batch lists only the ones moving or needing someone. */
const ITEMS_LISTED = 40;

/** The folder an item goes into, as a person reads it: its parent as it landed, or the transfer's. */
function folderOf(batch: TransferBatch, item: TransferItem): string {
  if (item.relative.length === 1) return batch.destLabel;
  const parent = item.relative.slice(0, -1);
  const landed = batch.items.find(
    (candidate) =>
      candidate.kind === "folder" &&
      candidate.relative.length === parent.length &&
      candidate.relative.every((name, index) => parent[index] === name),
  );
  return landed?.savedAs ?? parent.at(-1) ?? batch.destLabel;
}

export function itemStatusLabel(item: TransferItem, batch: TransferBatch): string {
  switch (item.state) {
    case "queued":
      return ITEM_WAITING;
    case "running":
      if (item.phase === "streaming" && item.total > 0) {
        const percent = Math.min(100, Math.floor((item.transferred / item.total) * 100));
        return `${percent}% · ${formatFileSize(item.transferred)} of ${formatFileSize(item.total)}`;
      }
      if (item.phase === "finalizing" || item.phase === "outcome_unknown") return ITEM_FINISHING;
      return item.phase === "hashing" && item.total > 0 && item.transferred > 0
        ? preparingLabel(Math.min(100, Math.floor((item.transferred / item.total) * 100)))
        : PREPARING;
    case "done":
      if (item.savedAs) return savedAsLabel(item.savedAs);
      if (item.outcome === "replaced") return ITEM_REPLACED;
      if (item.outcome === "merged") return ITEM_MERGED;
      if (item.outcome === "verified") return ITEM_VERIFIED;
      return ITEM_DONE;
    case "skipped":
      return ITEM_SKIPPED;
    case "cancelled":
      return TRANSFER_CANCELLED;
    case "interrupted":
      return interruptedNotice(item.interruption ?? { cause: "background" });
    case "conflict":
      return conflictQuestion({
        name: item.name,
        isDir: item.kind === "folder",
        folderLabel: folderOf(batch, item),
        hostName: batch.destination.name,
      });
    default:
      return item.error ?? "";
  }
}

/**
 * The line under a transfer's title: how far it has got and about how long
 * is left over the whole transfer, why it is waiting, or how it ended.
 */
export function batchStatusLine(
  batch: TransferBatch,
  runningElsewhere: TransferBatch | null,
): string {
  const progress = batchProgress(batch);
  if (isSettledBatch(batch)) {
    if (batch.cancelled) return TRANSFER_CANCELLED;
    if (progress.failed > 0) return transferFailedSummary(progress.failed, batch.kind);
    return transferDoneSummary({
      items: progress.totalItems - progress.skipped,
      bytes: progress.doneBytes,
      skipped: progress.skipped,
    });
  }
  const interrupted = batch.items.find((item) => item.state === "interrupted");
  if (interrupted) return interruptedNotice(interrupted.interruption ?? { cause: "background" });
  const running = batch.items.some((item) => item.state === "running");
  if (!running && runningElsewhere && runnableItem(batch)) {
    return queuedNotice(runningElsewhere.destination.name);
  }
  const seconds = running
    ? estimateSeconds(Math.max(0, progress.totalBytes - progress.doneBytes), batch.rate)
    : null;
  return transferProgress({ ...progress, secondsLeft: worthEstimating(seconds) ? seconds : null });
}

function itemIcon(item: TransferItem): {
  name: IconName;
  color: "mutedForeground" | "success" | "destructive" | "warning";
} {
  switch (item.state) {
    case "done":
      return { name: "CheckCircle2", color: "success" };
    case "skipped":
    case "cancelled":
      return { name: "X", color: "mutedForeground" };
    case "failed":
      return { name: "AlertCircle", color: "destructive" };
    case "interrupted":
    case "conflict":
      return { name: "AlertTriangle", color: "warning" };
    default:
      return { name: item.kind === "folder" ? "Folder" : "File", color: "mutedForeground" };
  }
}

/** A folder's own row is worth showing when it was picked, or when something happened to it. */
function listsItem(item: TransferItem): boolean {
  return (
    item.kind === "file" ||
    item.relative.length === 1 ||
    item.state === "conflict" ||
    item.state === "failed" ||
    item.state === "interrupted"
  );
}

/**
 * Every upload and send since the app opened, with each one's progress and
 * what can be done about the ones that stopped: Cancel, Retry, Resume after
 * the app went to the background or lost touch with a host, and an answer
 * for a name already taken. Mounted once beside the runner, so it shows the
 * same queue from any host's files; opened from the banner over their lists.
 */
export function TransfersSheet(): React.JSX.Element {
  const theme = useTheme();
  const visible = useTransfersStore((state) => state.sheetVisible);
  const batches = useTransfersStore((state) => state.batches);
  const pausedBy = useTransfersStore((state) => (state.paused ? state.pausedBy : null));
  const paused = useTransfersStore((state) => state.paused);
  const hideSheet = useTransfersStore((state) => state.hideSheet);
  const resume = useTransfersStore((state) => state.resume);
  const runningBatch =
    batches.find((batch) => batch.items.some((item) => item.state === "running")) ?? null;
  const anyFinished = batches.some(isSettledBatch);
  const lostTouch = pausedBy?.cause === "lost-touch" ? pausedBy : null;

  return (
    <Sheet onDismiss={hideSheet} size="tall" testID="transfers-sheet" visible={visible}>
      <SheetHeader
        action={
          anyFinished ? (
            <Button onPress={clearFinishedTransfers} size="sm" variant="ghost">
              {CLEAR_FINISHED}
            </Button>
          ) : undefined
        }
        title={TRANSFERS_TITLE}
      />
      <SheetScrollView contentContainerStyle={styles.content}>
        {paused ? (
          <View style={[styles.notice, { backgroundColor: theme.colors.warningSoft }]}>
            <Text color="warning" variant="label" weight="semibold">
              {lostTouch ? interruptedNotice(lostTouch) : PAUSED_TITLE}
            </Text>
            <Text color="warning" variant="caption">
              {lostTouch ? RESUME_DETAIL : PAUSED_DETAIL}
            </Text>
            <Button onPress={resume} size="sm" testID="transfers-resume">
              {RESUME}
            </Button>
          </View>
        ) : runningBatch ? (
          <Text color="mutedForeground" style={styles.keepOpen} variant="caption">
            {KEEP_OPEN}
          </Text>
        ) : null}
        {batches.length === 0 ? (
          <Text color="mutedForeground" style={styles.empty}>
            Nothing is being uploaded or sent.
          </Text>
        ) : (
          batches.map((batch) => (
            <BatchCard
              batch={batch}
              key={batch.id}
              runningElsewhere={runningBatch && runningBatch.id !== batch.id ? runningBatch : null}
            />
          ))
        )}
      </SheetScrollView>
    </Sheet>
  );
}

function BatchCard({
  batch,
  runningElsewhere,
}: {
  batch: TransferBatch;
  runningElsewhere: TransferBatch | null;
}): React.JSX.Element {
  const theme = useTheme();
  const cancelBatch = useTransfersStore((state) => state.cancelBatch);
  const retryBatch = useTransfersStore((state) => state.retryBatch);
  const [applyToRest, setApplyToRest] = useState(false);
  const settled = isSettledBatch(batch);
  const failed = batch.items.some((item) => item.state === "failed");
  const percent = settled ? null : batchPercent(batch);
  const conflicts = batch.items.filter((item) => item.state === "conflict").length;
  const shown = batch.items.filter(listsItem);
  const listed =
    shown.length <= ITEMS_LISTED
      ? shown
      : shown.filter(
          (item) => item.state !== "done" && item.state !== "skipped" && item.state !== "queued",
        );
  const unlisted = shown.length - listed.length;
  const title = transferTitle({
    verb: batch.kind,
    names: batch.names,
    ...(batch.source ? { from: batch.source.name } : {}),
    folderLabel: batch.destLabel,
    to: batch.destination.name,
    finished: settled && !batch.cancelled && !failed,
  });

  return (
    <View
      style={[styles.card, { borderColor: theme.colors.border, borderRadius: theme.radii.md }]}
      testID={`transfer-batch-${batch.id}`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardCopy}>
          <Text numberOfLines={2} variant="label" weight="semibold">
            {title}
          </Text>
          <Text color={settled && failed ? "destructive" : "mutedForeground"} variant="caption">
            {batchStatusLine(batch, runningElsewhere)}
          </Text>
        </View>
        {!settled ? (
          <Button onPress={() => cancelBatch(batch.id)} size="sm" variant="outline">
            Cancel
          </Button>
        ) : failed ? (
          <Button onPress={() => retryBatch(batch.id)} size="sm" variant="outline">
            Retry
          </Button>
        ) : null}
      </View>
      {percent !== null ? (
        <View style={[styles.track, { backgroundColor: theme.colors.muted }]}>
          <View
            style={[styles.fill, { backgroundColor: theme.colors.primary, width: `${percent}%` }]}
          />
        </View>
      ) : null}
      {listed.map((item) => (
        <ItemRow
          applyToRest={applyToRest}
          batch={batch}
          item={item}
          key={item.id}
          otherConflicts={conflicts - 1}
          setApplyToRest={setApplyToRest}
        />
      ))}
      {unlisted > 0 ? (
        <Text color="mutedForeground" variant="caption">
          {`${unlisted.toLocaleString("en-US")} more not shown: waiting or done.`}
        </Text>
      ) : null}
    </View>
  );
}

function ItemRow({
  batch,
  item,
  applyToRest,
  setApplyToRest,
  otherConflicts,
}: {
  batch: TransferBatch;
  item: TransferItem;
  applyToRest: boolean;
  setApplyToRest(value: boolean): void;
  otherConflicts: number;
}): React.JSX.Element {
  const retryItem = useTransfersStore((state) => state.retryItem);
  const decideConflict = useTransfersStore((state) => state.decideConflict);
  const icon = itemIcon(item);
  const status = item.state === "failed" ? (item.error ?? "") : itemStatusLabel(item, batch);
  const name = item.relative.join("/");
  const isDir = item.kind === "folder";
  const clashIsDir = item.clash?.isDir ?? isDir;
  return (
    <View style={styles.item} testID={`transfer-item-${item.id}`}>
      <View style={styles.itemLine}>
        {item.state === "running" ? (
          <Spinner label={name} size={spacing[4]} />
        ) : (
          <Icon color={icon.color} name={icon.name} />
        )}
        <View style={styles.itemCopy}>
          <Text numberOfLines={1} variant="label">
            {name}
          </Text>
          <Text
            accessibilityLiveRegion={item.state === "running" ? "none" : "polite"}
            color={
              item.state === "failed"
                ? "destructive"
                : item.state === "interrupted" || item.state === "conflict"
                  ? "warning"
                  : "mutedForeground"
            }
            variant="caption"
          >
            {status}
          </Text>
        </View>
        {item.state === "failed" ? (
          <Button onPress={() => retryItem(batch.id, item.id)} size="sm" variant="ghost">
            Retry
          </Button>
        ) : null}
      </View>
      {item.state === "conflict" ? (
        <View style={styles.conflict}>
          <View style={styles.choices}>
            {conflictChoices(isDir, clashIsDir).map((decision) => (
              <Button
                key={decision}
                onPress={() => decideConflict(batch.id, item.id, decision, applyToRest)}
                size="sm"
                variant={decision === "keep_both" ? "secondary" : "outline"}
              >
                {conflictDecisionLabel(decision, isDir && clashIsDir)}
              </Button>
            ))}
          </View>
          {otherConflicts > 0 ? (
            <View style={styles.restRow}>
              <Text style={styles.itemCopy} variant="caption">
                {conflictApplyToRest(otherConflicts)}
              </Text>
              <Switch
                accessibilityLabel={conflictApplyToRest(otherConflicts)}
                onValueChange={setApplyToRest}
                value={applyToRest}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: borderWidth.hairline,
    gap: spacing[2],
    padding: spacing[3],
  },
  cardCopy: { flex: 1, gap: spacing[0.5] },
  cardHeader: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  conflict: { gap: spacing[2], paddingLeft: spacing[6] },
  content: { gap: spacing[3], paddingBottom: spacing[6], paddingHorizontal: spacing[4] },
  empty: { paddingVertical: spacing[6], textAlign: "center" },
  fill: { height: "100%" },
  item: { gap: spacing[1] },
  itemCopy: { flex: 1, minWidth: 0 },
  itemLine: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  keepOpen: { textAlign: "center" },
  notice: { gap: spacing[2], padding: spacing[3] },
  restRow: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  track: { height: spacing[1], overflow: "hidden" },
});
