import { create } from "zustand";
import type { ConflictPolicy } from "@/components/files/transfer-plan";
import type { HostWritePhase } from "@/terminal/transport/types";

/**
 * Uploads and sends between hosts, for as long as the app is open.
 *
 * Kept in memory only: the queue names host paths, which are protected
 * content and stay out of device storage (docs/TRUST.md), and a transfer
 * cannot outlive the app anyway — the phone's host connections close a few
 * seconds after it leaves the screen. The engine that runs the queue is
 * `components/files/transfer-engine.ts`; its runner is mounted once for the
 * signed-in app, so a transfer carries on while the person moves between
 * screens.
 *
 * A batch is one transfer, as the person asked for it: the picked items and
 * everything under them. Each picked item settles a taken name once, for
 * itself and all it holds (web/src/lib/files/transfer-plan.ts `landingFor`).
 */

/** A host as a transfer needs it: enough to open its channel and to name it. */
export interface TransferHost {
  id: string;
  name: string;
  publicKey: string;
  os: string | null;
}

export type TransferItemState =
  /** Waiting its turn: one item moves at a time. */
  | "queued"
  | "running"
  | "done"
  /** Left out: the name was taken and the answer was to leave the one there. */
  | "skipped"
  | "failed"
  | "cancelled"
  /** Cut off by the phone or the connection; Resume sends it again. */
  | "interrupted"
  /** The name turned out to be taken and nobody has said what to do yet. */
  | "conflict";

/** Why a transfer stopped part-way, said with Resume beside it. */
export type TransferInterruption =
  /** The phone closes its host connections a few seconds after SPAWN D leaves the screen. */
  { cause: "background" } | { cause: "lost-touch"; host: string };

export type TransferSource =
  /** A file the phone picked, copied into the app's cache by the picker. */
  | { kind: "local"; uri: string; mimeType: string | null }
  /** A file or folder on the batch's source host. */
  | { kind: "host"; path: string };

/** How a finished item got there, when that is worth saying. */
export type TransferOutcome = "created" | "replaced" | "renamed" | "merged" | "verified";

export interface TransferItem {
  id: string;
  kind: "file" | "folder";
  /** The item's own name, as picked or as the source host spells it. */
  name: string;
  /**
   * Where it goes below the batch's destination folder, one name per level,
   * the picked item's own name first. Each folder above it lands under its
   * own item's name, which a kept-both folder changes.
   */
  relative: string[];
  size: number | null;
  source: TransferSource;
  /**
   * What a taken name gets. A picked item carries the transfer's choice, or
   * the answer to its question; what is inside a folder asks only if a name
   * turns up taken all the same, and is replaced when its folder was merged.
   */
  policy: ConflictPolicy;
  state: TransferItemState;
  phase: HostWritePhase | null;
  transferred: number;
  total: number;
  startedAt: number | null;
  /** When its bytes started to move, after any fingerprinting. */
  streamStartedAt: number | null;
  outcome: TransferOutcome | null;
  /** The name it was saved under, when that is not its own. */
  savedAs: string | null;
  error: string | null;
  /** What holds the name, while the item waits on an answer for it. */
  clash: { isDir: boolean } | null;
  /** Why it stopped, while it waits on Resume. */
  interruption: TransferInterruption | null;
  /**
   * The end of a write was sent and never answered: it may have arrived. Run
   * again, the item first asks the destination whether its file is there.
   */
  unconfirmed: { name: string } | null;
}

export interface TransferBatch {
  id: string;
  kind: "upload" | "send";
  /** The host files are read from; null for an upload from the phone. */
  source: TransferHost | null;
  destination: TransferHost;
  /** The destination folder, as the destination host spells it. */
  destDir: string;
  /** The destination folder as a person reads it: "Downloads", "Home". */
  destLabel: string;
  /** What was picked, by name, for the transfer's title. */
  names: string[];
  items: TransferItem[];
  createdAt: number;
  /** Cancel was asked for: the running item stops, the rest never start. */
  cancelled: boolean;
  /** Its outcome has been said once, as a notice. */
  notified: boolean;
  /** Bytes a second, measured while it runs or expected before; null until it has run. */
  rate: number | null;
}

export interface NewTransferItem {
  kind?: TransferItem["kind"];
  name: string;
  relative?: string[];
  size: number | null;
  source: TransferSource;
  policy: ConflictPolicy;
}

export interface NewTransferBatch {
  kind: TransferBatch["kind"];
  source: TransferHost | null;
  destination: TransferHost;
  destDir: string;
  destLabel: string;
  /** What was picked; the top-level items' names when not given. */
  names?: string[];
  items: NewTransferItem[];
  /** Files refused before they were queued (too large), shown failed with this reason. */
  refused?: { item: NewTransferItem; reason: string }[];
}

export interface TransfersState {
  batches: TransferBatch[];
  /** Something cut the queue off; nothing runs until Resume. */
  paused: boolean;
  /** What did, while paused. */
  pausedBy: TransferInterruption | null;
  sheetVisible: boolean;
  /** The last speed each route kept, by `routeKey`: what the next transfer on it expects. */
  routeRates: Readonly<Record<string, number>>;
  enqueue(batch: NewTransferBatch): string;
  patchItem(batchId: string, itemId: string, patch: Partial<TransferItem>): void;
  patchBatch(batchId: string, patch: Partial<Pick<TransferBatch, "notified" | "rate">>): void;
  /** Gives every item still waiting inside `folder` (its `relative`) the same end. */
  settleInside(
    batchId: string,
    folder: readonly string[],
    patch: Pick<TransferItem, "state"> & Partial<TransferItem>,
  ): void;
  cancelBatch(batchId: string): void;
  retryItem(batchId: string, itemId: string): void;
  retryBatch(batchId: string): void;
  /** The answer to a taken name, for this item and, if asked, every other waiting on one. */
  decideConflict(
    batchId: string,
    itemId: string,
    policy: Exclude<ConflictPolicy, "ask">,
    applyToRest: boolean,
  ): void;
  pause(cause: TransferInterruption): void;
  resume(): void;
  rememberRate(route: string, bytesPerSecond: number): void;
  /** Removes every batch with nothing left to run, and returns them. */
  clearFinished(): TransferBatch[];
  showSheet(): void;
  hideSheet(): void;
  /** Forgets everything, and returns what was forgotten. */
  reset(): TransferBatch[];
}

const FINAL_STATES: ReadonlySet<TransferItemState> = new Set([
  "done",
  "skipped",
  "failed",
  "cancelled",
]);

export function isFinalItem(item: Pick<TransferItem, "state">): boolean {
  return FINAL_STATES.has(item.state);
}

/** Whether nothing in the batch can still move without someone asking. */
export function isSettledBatch(batch: TransferBatch): boolean {
  return batch.items.every(isFinalItem);
}

/** Whether `inner` is inside the folder `outer` (both `relative`). */
export function isInside(outer: readonly string[], inner: readonly string[]): boolean {
  return inner.length > outer.length && outer.every((name, index) => inner[index] === name);
}

const keyOf = (relative: readonly string[]) => relative.join("\u0000");

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function newItem(item: NewTransferItem, state: TransferItemState = "queued"): TransferItem {
  return {
    id: nextId("item"),
    kind: item.kind ?? "file",
    name: item.name,
    relative: item.relative ?? [item.name],
    size: item.size,
    source: item.source,
    policy: item.policy,
    state,
    phase: null,
    transferred: 0,
    total: item.size ?? 0,
    startedAt: null,
    streamStartedAt: null,
    outcome: null,
    savedAs: null,
    error: null,
    clash: null,
    interruption: null,
    unconfirmed: null,
  };
}

/** Back in the queue, with what the last run said cleared. */
function requeued(item: TransferItem): TransferItem {
  return {
    ...item,
    state: "queued",
    phase: null,
    transferred: 0,
    startedAt: null,
    streamStartedAt: null,
    outcome: null,
    savedAs: null,
    error: null,
    clash: null,
    interruption: null,
  };
}

function mapBatch(
  batches: TransferBatch[],
  batchId: string,
  update: (batch: TransferBatch) => TransferBatch,
): TransferBatch[] {
  return batches.map((batch) => (batch.id === batchId ? update(batch) : batch));
}

function mapItems(
  batch: TransferBatch,
  update: (item: TransferItem) => TransferItem,
): TransferBatch {
  return { ...batch, items: batch.items.map(update) };
}

const retryable = (item: TransferItem) => item.state === "failed" || item.state === "cancelled";

export const useTransfersStore = create<TransfersState>()((set, get) => ({
  batches: [],
  paused: false,
  pausedBy: null,
  sheetVisible: false,
  routeRates: {},
  enqueue(input) {
    const id = nextId("batch");
    const batch: TransferBatch = {
      id,
      kind: input.kind,
      source: input.source,
      destination: input.destination,
      destDir: input.destDir,
      destLabel: input.destLabel,
      names:
        input.names ??
        [...input.items, ...(input.refused ?? []).map(({ item }) => item)]
          .filter((item) => (item.relative ?? [item.name]).length === 1)
          .map((item) => item.name),
      items: [
        ...input.items.map((item) => newItem(item)),
        ...(input.refused ?? []).map(({ item, reason }) => ({
          ...newItem(item, "failed"),
          error: reason,
        })),
      ],
      createdAt: Date.now(),
      cancelled: false,
      notified: false,
      rate: null,
    };
    set((state) => ({ batches: [...state.batches, batch] }));
    return id;
  },
  patchItem(batchId, itemId, patch) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) =>
        mapItems(batch, (item) => (item.id === itemId ? { ...item, ...patch } : item)),
      ),
    }));
  },
  patchBatch(batchId, patch) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) => ({ ...batch, ...patch })),
    }));
  },
  settleInside(batchId, folder, patch) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) =>
        mapItems(batch, (item) =>
          isInside(folder, item.relative) && !isFinalItem(item) && item.state !== "running"
            ? { ...item, phase: null, ...patch }
            : item,
        ),
      ),
    }));
  },
  cancelBatch(batchId) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) =>
        mapItems(
          { ...batch, cancelled: true },
          // The running one is the engine's to stop; it says so when it has.
          (item) =>
            item.state === "queued" || item.state === "interrupted" || item.state === "conflict"
              ? { ...item, state: "cancelled", phase: null }
              : item,
        ),
      ),
    }));
  },
  retryItem(batchId, itemId) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) => {
        const target = batch.items.find((item) => item.id === itemId);
        if (!target || !retryable(target)) return batch;
        // A folder goes again with what it holds, and an item with the folders it needs.
        const goes = (item: TransferItem) =>
          item.id === itemId ||
          (retryable(item) &&
            (isInside(target.relative, item.relative) ||
              (item.kind === "folder" && isInside(item.relative, target.relative))));
        return mapItems({ ...batch, cancelled: false, notified: false }, (item) =>
          goes(item) ? requeued(item) : item,
        );
      }),
    }));
  },
  retryBatch(batchId) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) =>
        mapItems({ ...batch, cancelled: false, notified: false }, (item) =>
          retryable(item) ? requeued(item) : item,
        ),
      ),
    }));
  },
  decideConflict(batchId, itemId, policy, applyToRest) {
    set((state) => ({
      batches: mapBatch(state.batches, batchId, (batch) =>
        mapItems(batch, (item) => {
          if (item.id === itemId) return { ...requeued(item), policy };
          if (!applyToRest) return item;
          if (item.state === "conflict") return { ...requeued(item), policy };
          // The other picked items still to run take the answer too, so nobody
          // is asked twice. What is inside a folder follows its folder instead.
          return item.state === "queued" && item.policy === "ask" && item.relative.length === 1
            ? { ...item, policy }
            : item;
        }),
      ),
    }));
  },
  pause(cause) {
    set((state) => ({ paused: true, pausedBy: state.pausedBy ?? cause }));
  },
  resume() {
    set((state) => ({
      paused: false,
      pausedBy: null,
      batches: state.batches.map((batch) =>
        mapItems(batch, (item) => (item.state === "interrupted" ? requeued(item) : item)),
      ),
    }));
  },
  rememberRate(route, bytesPerSecond) {
    if (!(bytesPerSecond > 0)) return;
    set((state) => ({ routeRates: { ...state.routeRates, [route]: bytesPerSecond } }));
  },
  clearFinished() {
    const removed = get().batches.filter(isSettledBatch);
    if (removed.length === 0) return [];
    set((state) => ({ batches: state.batches.filter((batch) => !isSettledBatch(batch)) }));
    return removed;
  },
  showSheet() {
    set({ sheetVisible: true });
  },
  hideSheet() {
    set({ sheetVisible: false });
  },
  reset() {
    const removed = get().batches;
    set({ batches: [], paused: false, pausedBy: null, sheetVisible: false });
    return removed;
  },
}));

/**
 * The first item of `batch` that can run now: queued, and with the folder it
 * goes into already made. What is inside a folder waiting on an answer, or on
 * Resume, waits with it.
 */
export function runnableItem(batch: TransferBatch): TransferItem | null {
  const made = new Set<string>();
  for (const item of batch.items) {
    if (item.kind === "folder" && item.state === "done") made.add(keyOf(item.relative));
    if (item.state !== "queued") continue;
    if (item.relative.length === 1 || made.has(keyOf(item.relative.slice(0, -1)))) return item;
  }
  return null;
}

/** The next item to move, in the order they were asked for, or null while paused. */
export function nextQueuedItem(
  state: Pick<TransfersState, "batches" | "paused">,
): { batch: TransferBatch; item: TransferItem } | null {
  if (state.paused) return null;
  for (const batch of state.batches) {
    const item = runnableItem(batch);
    if (item) return { batch, item };
  }
  return null;
}

/** The hosts the queue needs a channel to now: those of every batch with something to move. */
export function hostsInUse(state: Pick<TransfersState, "batches" | "paused">): TransferHost[] {
  if (state.paused) return [];
  const hosts = new Map<string, TransferHost>();
  for (const batch of state.batches) {
    const moving =
      batch.items.some((item) => item.state === "running") || runnableItem(batch) !== null;
    if (!moving) continue;
    for (const host of [batch.source, batch.destination]) {
      if (host && !hosts.has(host.id)) hosts.set(host.id, host);
    }
  }
  return [...hosts.values()];
}

/** One file's share of a batch's bytes: done counts whole, the running one as far as it got. */
function bytesMoved(item: TransferItem): number {
  if (item.state === "done") return item.total;
  if (item.state === "running" && item.phase === "streaming") return item.transferred;
  if (item.state === "running" && (item.phase === "finalizing" || item.phase === "outcome_unknown"))
    return item.total;
  return 0;
}

/** Bytes, files and how far a batch has got: what its progress line and its estimate read. */
export interface BatchProgress {
  doneBytes: number;
  /** The bytes it will move: files left out, refused or cancelled are not counted. */
  totalBytes: number;
  doneItems: number;
  totalItems: number;
  skipped: number;
  failed: number;
}

export function batchProgress(batch: TransferBatch): BatchProgress {
  const progress: BatchProgress = {
    doneBytes: 0,
    totalBytes: 0,
    doneItems: 0,
    totalItems: 0,
    skipped: 0,
    failed: 0,
  };
  for (const item of batch.items) {
    if (item.state === "failed") progress.failed += 1;
    if (item.kind !== "file") continue;
    progress.totalItems += 1;
    if (item.state === "skipped") progress.skipped += 1;
    if (item.state === "done") progress.doneItems += 1;
    if (item.state === "skipped" || item.state === "cancelled" || item.state === "failed") continue;
    progress.totalBytes += item.total;
    progress.doneBytes += Math.min(item.total, bytesMoved(item));
  }
  return progress;
}

export function batchPercent(batch: TransferBatch): number | null {
  const { doneBytes, totalBytes } = batchProgress(batch);
  if (totalBytes <= 0) return null;
  return Math.min(100, Math.floor((doneBytes / totalBytes) * 100));
}

/** Whether a batch waits on the person: a question about a name, or Resume. */
export function batchNeedsYou(batch: TransferBatch): boolean {
  return batch.items.some((item) => item.state === "conflict" || item.state === "interrupted");
}

export interface TransfersSummary {
  /** Transfers not finished, the ones waiting on the person among them. */
  active: number;
  /** Bytes moved across the transfers not finished, or null when sizes are unknown. */
  percent: number | null;
  paused: boolean;
  /** Transfers asking about a name, or stopped part-way. */
  needsYou: number;
  /** Anything to show at all. */
  any: boolean;
  running: boolean;
}

/** The queue as the banner says it: transfers, as the person asked for them, never files. */
export function summarizeTransfers(
  state: Pick<TransfersState, "batches" | "paused">,
): TransfersSummary {
  let active = 0;
  let needsYou = 0;
  let running = false;
  let total = 0;
  let moved = 0;
  for (const batch of state.batches) {
    if (batch.items.some((item) => item.state === "running")) running = true;
    if (batchNeedsYou(batch)) needsYou += 1;
    if (isSettledBatch(batch)) continue;
    active += 1;
    const progress = batchProgress(batch);
    total += progress.totalBytes;
    moved += progress.doneBytes;
  }
  return {
    active,
    percent: active > 0 && total > 0 ? Math.min(100, Math.floor((moved / total) * 100)) : null,
    paused: state.paused,
    needsYou,
    any: state.batches.length > 0,
    running,
  };
}
