import { fileErrorCode } from "@/components/files/errors";
import { joinDirectory, type PathFlavor, pathFlavorForHostOS } from "@/components/files/paths";
import { HOST_TRANSFER_MAX_BYTES, HostTransferError } from "@/components/files/transfer";
import {
  makeFolderFailed,
  tooLargeFile,
  transferErrorCopy,
} from "@/components/files/transfer-copy";
import {
  type ConflictPolicy,
  destinationPath,
  expectedRate,
  firstFreeName,
  RateMeter,
  routeKey,
  settleDecision,
} from "@/components/files/transfer-plan";
import type { LocalFileSource } from "@/components/files/upload-source";
import { fetchHostListing, hostCan, statHostEntry } from "@/data/queries/files";
import {
  isSettledBatch,
  nextQueuedItem,
  type TransferBatch,
  type TransferHost,
  type TransferItem,
  type TransferOutcome,
  useTransfersStore,
} from "@/data/stores/transfers";
import { hashHostFileSource } from "@/terminal/transport/host-ctl-codec";
import type { HostTransport, HostWriteProgress } from "@/terminal/transport/types";

/**
 * Runs the transfer queue (`data/stores/transfers.ts`), one item at a time.
 *
 * One at a time because a v1 host takes writes on a channel one stream at a
 * time, and because every byte of a send crosses the phone twice: running two
 * would only halve each. Files are written under SPAWN D's own rules for a
 * host write — fingerprinted first, committed atomically, and refused if a
 * byte differs — so a file either arrives whole or not at all.
 *
 * A taken name is settled per picked item, as the web does: "Keep both" on a
 * folder makes "photos (2)" and everything in it goes there, "Skip" leaves
 * the whole folder out, and "Replace" on a folder merges — files of the same
 * name inside are replaced, folders merged. It is settled before anything is
 * read where that can be known (`fs.stat`, or the folder's listing on a host
 * without it), so a kept copy or a skip costs no bytes; the host's own
 * refusal at the start of a write is the backstop for a name taken in between.
 *
 * A transfer cut off is not a failure. The phone closes its host connections
 * a few seconds after the app leaves the screen, and a connection can drop
 * while it is on screen; either way the item is marked interrupted, the queue
 * pauses, and the Transfers sheet offers Resume.
 */

/** Channels to hosts, held open by whatever runs the engine for as long as the queue needs them. */
export interface TransferPool {
  /** A ready channel to `host`; rejects when the host cannot be reached or `signal` aborts. */
  acquire(host: TransferHost, signal: AbortSignal): Promise<HostTransport>;
}

export interface TransferEngineOptions {
  pool: TransferPool;
  openLocal(uri: string): LocalFileSource;
  /** Goes up each time the app leaves the screen: a failure across a change is an interruption. */
  backgroundEpoch(): number;
  appActive(): boolean;
  now?: () => number;
  /** How often a running file's progress reaches the store. */
  progressIntervalMs?: number;
  /** Every time an item stops running, whatever its outcome. */
  onItemSettled?(batchId: string, itemId: string): void;
}

export interface TransferEngine {
  /** Starts the queue if it has something to run and is not running already. */
  kick(): void;
  dispose(): void;
}

type Settled =
  | { state: "done"; outcome: TransferOutcome; savedAs: string | null }
  | { state: "skipped" }
  | { state: "conflict"; clash: { isDir: boolean } };

interface Running {
  batchId: string;
  itemId: string;
  controller: AbortController;
  reason: "cancel" | "dispose" | null;
}

interface RunContext {
  batch: TransferBatch;
  item: TransferItem;
  signal: AbortSignal;
  /** Which host answered last: a send reads from one and writes to the other. */
  side: "source" | "destination";
  /** The name a write's end was sent for, once it has been: it may have arrived. */
  dispatchedName: string | null;
  progress(progress: HostWriteProgress): void;
}

/** How a batch is going: what its estimate reads, and what the route keeps afterwards. */
interface Pace {
  meter: RateMeter;
  /** Bytes moved by the files finished in this run. */
  base: number;
  moved: number;
  /** Time spent moving them, so a pause or a question does not slow the speed kept. */
  activeMs: number;
  expected: number | null;
  patchedAt: number;
}

const PROGRESS_INTERVAL_MS = 250;
const NAME_RACE_ATTEMPTS = 3;
/** A route keeps its speed only from a transfer long enough to say something. */
const RATE_MIN_BYTES = 1024 * 1024;
const RATE_MIN_MS = 2_000;

/** Codes that mean the path to the host went, not that the host said no (web: TRANSPORT_CODES). */
const LOST_TOUCH_CODES: ReadonlySet<string> = new Set([
  "connection_closed",
  "connect_timeout",
  "host_unreachable",
  "stream_timeout",
  "stream_failed",
  "outcome_unknown",
]);

function codeOf(error: unknown): string | null {
  return fileErrorCode(error);
}

/** The connection under a transfer went; the host itself refused nothing. */
export function isLostTouch(error: unknown): boolean {
  const code = codeOf(error);
  return code !== null && LOST_TOUCH_CODES.has(code);
}

/**
 * Stops between steps once Cancel is asked for: a host request that does not
 * take the signal (a name check, say) still answers, and nothing after it may
 * start.
 */
function stopIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new HostTransferError("cancelled", "Transfer cancelled.");
}

const keyOf = (relative: readonly string[]) => relative.join("\u0000");

/** The folder items of a batch, by where they are in it. */
function foldersOf(batch: TransferBatch): Map<string, TransferItem> {
  const folders = new Map<string, TransferItem>();
  for (const item of batch.items) {
    if (item.kind === "folder") folders.set(keyOf(item.relative), item);
  }
  return folders;
}

/** The names the folders above `item` landed under, below the destination folder. */
function landedParents(item: TransferItem, folders: ReadonlyMap<string, TransferItem>): string[] {
  const names: string[] = [];
  for (let depth = 1; depth < item.relative.length; depth += 1) {
    const folder = folders.get(keyOf(item.relative.slice(0, depth)));
    names.push(folder?.savedAs ?? item.relative[depth - 1] ?? "");
  }
  return names;
}

/**
 * What a taken name gets. A picked item says for itself; inside a folder
 * that was merged, a file with the same name is replaced and a folder merged
 * ("Files with the same name are replaced, and folders merged"); anywhere
 * else inside, a name taken all the same is asked about.
 */
function effectivePolicy(
  item: TransferItem,
  folders: ReadonlyMap<string, TransferItem>,
): ConflictPolicy {
  if (item.policy !== "ask" || item.relative.length === 1) return item.policy;
  const parent = folders.get(keyOf(item.relative.slice(0, -1)));
  return parent?.outcome === "merged" ? "replace" : "ask";
}

type NamePresence = "folder" | "item" | "free";

/**
 * What holds names in `dir`: `presence` asks after one name exactly as the
 * host would find it (`fs.stat`, or its listing on a host without it);
 * `taken` is the stricter test a kept-both name passes — free of every name
 * in the listing without regard to case, then free on the host itself.
 */
function nameProbe(dest: HostTransport, dir: string, flavor: PathFlavor) {
  const canStat = hostCan(dest, "fs.stat");
  const fold = (name: string) => (flavor === "windows" ? name.toLocaleLowerCase() : name);
  let listed: Promise<{ exact: Map<string, boolean>; anyCase: Set<string> }> | null = null;
  const listing = () => {
    listed ??= fetchHostListing(dest, dir).then(({ entries }) => ({
      exact: new Map(entries.map((entry) => [fold(entry.name), entry.is_dir === true])),
      anyCase: new Set(entries.map((entry) => entry.name.toLowerCase())),
    }));
    return listed;
  };
  /** Names the host itself has said are taken, in case the listing never showed them. */
  const refused = new Set<string>();
  const presence = async (name: string): Promise<NamePresence> => {
    if (canStat) {
      try {
        const found = await statHostEntry(dest, joinDirectory(dir, name, flavor));
        return found.kind === "directory" ? "folder" : "item";
      } catch (error) {
        const code = codeOf(error);
        if (code === "not_found") return refused.has(name) ? "item" : "free";
        // A link is refused rather than followed, but it is there all the same.
        if (code === "symlink_rejected") return "item";
        throw error;
      }
    }
    // A name past the listing's limit is not seen here, and the write's own
    // refusal answers for it.
    const isDir = (await listing()).exact.get(fold(name));
    if (isDir === undefined) return refused.has(name) ? "item" : "free";
    return isDir ? "folder" : "item";
  };
  const taken = async (name: string): Promise<boolean> => {
    if (refused.has(name) || (await listing()).anyCase.has(name.toLowerCase())) return true;
    return canStat ? (await presence(name)) !== "free" : false;
  };
  return { presence, taken, refuse: (name: string) => refused.add(name) };
}

type Landing =
  | { kind: "write"; name: string; overwrite: boolean; existed: boolean }
  | { kind: "merge" }
  | { kind: "skipped" }
  | { kind: "conflict"; clashIsDir: boolean };

/** Where one item lands in `dir`, under `policy`, against what holds its name now. */
async function chooseLanding(
  probe: ReturnType<typeof nameProbe>,
  item: TransferItem,
  policy: ConflictPolicy,
): Promise<Landing> {
  const isDir = item.kind === "folder";
  const there = await probe.presence(item.name);
  if (there === "free") return { kind: "write", name: item.name, overwrite: false, existed: false };
  const clashIsDir = there === "folder";
  if (policy === "ask") return { kind: "conflict", clashIsDir };
  const decision = settleDecision(policy, isDir, clashIsDir);
  if (decision === "skip") return { kind: "skipped" };
  if (decision === "replace") {
    return isDir
      ? { kind: "merge" }
      : { kind: "write", name: item.name, overwrite: true, existed: true };
  }
  const name = await firstFreeName(item.name, probe.taken, { isDir });
  if (name === null) throw new HostTransferError("already_exists", "Every name tried is taken.");
  return { kind: "write", name, overwrite: false, existed: false };
}

/** What the destination holds at `path`, against what was being sent. */
async function landedAs(
  dest: HostTransport,
  path: string,
  expected: () => Promise<{ sha256: string; length: number } | null>,
  signal: AbortSignal,
): Promise<"landed" | "absent" | "other"> {
  if (!dest.readFile || !hostCan(dest, "fs.read")) return "other";
  try {
    // The declaration carries the host's own fingerprint of the whole file;
    // nothing past it is read.
    const there = await dest.readFile(path, { signal });
    void there.stream.cancel().catch(() => undefined);
    const wanted = await expected();
    return wanted && wanted.sha256 === there.sha256 && wanted.length === there.length
      ? "landed"
      : "other";
  } catch (error) {
    if (signal.aborted) throw error;
    return codeOf(error) === "not_found" ? "absent" : "other";
  }
}

export function createTransferEngine(options: TransferEngineOptions): TransferEngine {
  const now = options.now ?? Date.now;
  /** The picker's copy, or why it cannot be read: the system may have cleared the cache. */
  const openLocal = (uri: string): LocalFileSource => {
    try {
      return options.openLocal(uri);
    } catch {
      throw new HostTransferError("local_missing", "The picked file is gone.");
    }
  };
  const interval = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const store = useTransfersStore;
  const paces = new Map<string, Pace>();
  let looping = false;
  let disposed = false;
  let current: Running | null = null;

  const patch = (batchId: string, itemId: string, values: Partial<TransferItem>) =>
    store.getState().patchItem(batchId, itemId, values);

  const paceOf = (batchId: string): Pace => {
    let pace = paces.get(batchId);
    if (!pace) {
      pace = {
        meter: new RateMeter(),
        base: 0,
        moved: 0,
        activeMs: 0,
        expected: null,
        patchedAt: 0,
      };
      paces.set(batchId, pace);
    }
    return pace;
  };

  const acquire = (context: RunContext, host: TransferHost, side: RunContext["side"]) => {
    context.side = side;
    return options.pool.acquire(host, context.signal);
  };

  /** Before anything is measured, the batch goes at what its route did last, or its legs' model. */
  const expectPace = (
    batch: TransferBatch,
    legs: { host: TransferHost; transport: HostTransport }[],
  ) => {
    const pace = paceOf(batch.id);
    if (pace.expected !== null) return;
    pace.expected = expectedRate(
      legs.map(({ host, transport }) => ({ hostId: host.id, info: transport.connectionInfo })),
      store.getState().routeRates,
    );
    store.getState().patchBatch(batch.id, { rate: pace.meter.rate() ?? pace.expected });
  };

  const progressReporter = (batchId: string, itemId: string, signal: AbortSignal) => {
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastPhase: HostWriteProgress["phase"] | null = null;
    const pace = paceOf(batchId);
    return (progress: HostWriteProgress) => {
      if (signal.aborted) return;
      const at = now();
      if (progress.phase === "streaming") {
        pace.moved = pace.base + progress.transferred;
        pace.meter.note(at, pace.moved);
      }
      if (progress.phase === lastPhase && at - lastAt < interval) return;
      const streamingStarts = progress.phase === "streaming" && lastPhase !== "streaming";
      lastAt = at;
      lastPhase = progress.phase;
      patch(batchId, itemId, {
        ...(streamingStarts ? { streamStartedAt: at } : {}),
        phase: progress.phase,
        total: progress.total,
        // While hashing, how far the phone has read the file to fingerprint it.
        transferred:
          progress.phase === "streaming" || progress.phase === "hashing"
            ? progress.transferred
            : progress.phase === "finalizing" || progress.phase === "outcome_unknown"
              ? progress.total
              : 0,
      });
      if (at - pace.patchedAt >= interval) {
        pace.patchedAt = at;
        store.getState().patchBatch(batchId, { rate: pace.meter.rate() ?? pace.expected });
      }
    };
  };

  /**
   * Writes under the item's landing, and if the host says the name was taken
   * in the moment since it was checked, settles it again the way the check
   * would have: skip, ask, replace, or the next free name.
   */
  async function writeUnderPolicy(
    context: RunContext,
    probe: ReturnType<typeof nameProbe>,
    policy: ConflictPolicy,
    first: Landing,
    write: (name: string, overwrite: boolean) => Promise<unknown>,
  ): Promise<Settled> {
    const { item } = context;
    let landing = first;
    for (let attempt = 1; ; attempt += 1) {
      stopIfCancelled(context.signal);
      if (landing.kind === "skipped") return { state: "skipped" };
      if (landing.kind === "conflict") {
        return { state: "conflict", clash: { isDir: landing.clashIsDir } };
      }
      if (landing.kind !== "write") throw new Error("A file is never merged.");
      try {
        await write(landing.name, landing.overwrite);
        const savedAs = landing.name === item.name ? null : landing.name;
        return {
          state: "done",
          outcome: savedAs
            ? "renamed"
            : landing.overwrite && landing.existed
              ? "replaced"
              : "created",
          savedAs,
        };
      } catch (error) {
        if (
          codeOf(error) !== "already_exists" ||
          landing.overwrite ||
          attempt >= NAME_RACE_ATTEMPTS
        ) {
          throw error;
        }
        probe.refuse(landing.name);
        landing = await chooseLanding(probe, item, policy);
      }
    }
  }

  async function runUpload(context: RunContext): Promise<Settled> {
    const { batch, item, signal } = context;
    if (item.source.kind !== "local") throw new Error("An upload reads a file on the phone.");
    const dest = await acquire(context, batch.destination, "destination");
    if (!dest.writeFile || !hostCan(dest, "fs.write.begin")) {
      throw new HostTransferError("unsupported_operation", "The host cannot take files.");
    }
    expectPace(batch, [{ host: batch.destination, transport: dest }]);
    const flavor = pathFlavorForHostOS(batch.destination.os);
    const dir = batch.destDir;
    const uri = item.source.uri;

    if (item.unconfirmed) {
      const path = joinDirectory(dir, item.unconfirmed.name, flavor);
      const verdict = await landedAs(
        dest,
        path,
        async () => {
          const source = openLocal(uri);
          try {
            return { sha256: await hashHostFileSource(source, signal), length: source.size };
          } finally {
            source.close();
          }
        },
        signal,
      );
      stopIfCancelled(signal);
      const savedAs = item.unconfirmed.name === item.name ? null : item.unconfirmed.name;
      patch(batch.id, item.id, { unconfirmed: null });
      if (verdict === "landed") return { state: "done", outcome: "verified", savedAs };
    }

    const source = openLocal(uri);
    try {
      const limit = dest.capabilities?.limits.fileBytes ?? HOST_TRANSFER_MAX_BYTES;
      if (source.size > Math.min(limit, HOST_TRANSFER_MAX_BYTES)) {
        throw new HostTransferError("file_too_large", tooLargeFile(item.name));
      }
      const probe = nameProbe(dest, dir, flavor);
      const policy = item.policy;
      const landing = await chooseLanding(probe, item, policy);
      const writeFile = dest.writeFile.bind(dest);
      return await writeUnderPolicy(context, probe, policy, landing, (name, overwrite) =>
        writeFile(
          source,
          { dir, name, overwrite },
          {
            signal,
            onProgress: (progress) => {
              if (progress.phase === "outcome_unknown") context.dispatchedName = name;
              context.progress(progress);
            },
          },
        ),
      );
    } finally {
      source.close();
    }
  }

  /** Makes a folder of a send at the destination, under the name its picked item settled on. */
  async function runFolder(context: RunContext): Promise<Settled> {
    const { batch, item, signal } = context;
    const dest = await acquire(context, batch.destination, "destination");
    if (!hostCan(dest, "fs.mkdir")) {
      throw new HostTransferError("unsupported_operation", "The host cannot take folders.");
    }
    const flavor = pathFlavorForHostOS(batch.destination.os);
    const folders = foldersOf(batch);
    const dir = destinationPath(batch.destDir, landedParents(item, folders), flavor);
    const probe = nameProbe(dest, dir, flavor);
    const landing = await chooseLanding(probe, item, effectivePolicy(item, folders));
    stopIfCancelled(signal);
    switch (landing.kind) {
      case "skipped":
        return { state: "skipped" };
      case "conflict":
        return { state: "conflict", clash: { isDir: landing.clashIsDir } };
      case "merge":
        return { state: "done", outcome: "merged", savedAs: null };
      default:
        break;
    }
    const path = joinDirectory(dir, landing.name, flavor);
    try {
      await dest.request("fs.mkdir", { path }, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      // SPAWN D's mkdir answers any failure as one it cannot vouch for: look.
      let there: NamePresence | "unknown" = "unknown";
      if (hostCan(dest, "fs.stat")) {
        there = await probe.presence(landing.name).catch(() => "unknown" as const);
      }
      if (there !== "folder") {
        if (there === "unknown" && isLostTouch(error)) throw error;
        const shown = [...landedParents(item, folders), landing.name].join("/");
        throw new HostTransferError(
          "folder_failed",
          makeFolderFailed(shown, batch.destination.name),
        );
      }
    }
    const savedAs = landing.name === item.name ? null : landing.name;
    return { state: "done", outcome: savedAs ? "renamed" : "created", savedAs };
  }

  async function runSend(context: RunContext): Promise<Settled> {
    const { batch, item, signal } = context;
    if (item.source.kind !== "host" || !batch.source) {
      throw new Error("A send reads a file on its source host.");
    }
    const sourcePath = item.source.path;
    const src = await acquire(context, batch.source, "source");
    const dest = await acquire(context, batch.destination, "destination");
    if (!src.transferFileTo || !hostCan(src, "fs.read")) {
      context.side = "source";
      throw new HostTransferError("unsupported_operation", "The host cannot send files.");
    }
    if (!hostCan(dest, "fs.write.begin")) {
      throw new HostTransferError("unsupported_operation", "The host cannot take files.");
    }
    expectPace(batch, [
      { host: batch.source, transport: src },
      { host: batch.destination, transport: dest },
    ]);
    const flavor = pathFlavorForHostOS(batch.destination.os);
    const folders = foldersOf(batch);
    const dir = destinationPath(batch.destDir, landedParents(item, folders), flavor);

    if (item.unconfirmed) {
      const verdict = await landedAs(
        dest,
        joinDirectory(dir, item.unconfirmed.name, flavor),
        async () => {
          const original = await src.readFile?.(sourcePath, { signal });
          if (!original) return null;
          void original.stream.cancel().catch(() => undefined);
          return { sha256: original.sha256, length: original.length };
        },
        signal,
      );
      stopIfCancelled(signal);
      const savedAs = item.unconfirmed.name === item.name ? null : item.unconfirmed.name;
      patch(batch.id, item.id, { unconfirmed: null });
      if (verdict === "landed") return { state: "done", outcome: "verified", savedAs };
    }

    const probe = nameProbe(dest, dir, flavor);
    const policy = effectivePolicy(item, folders);
    const landing = await chooseLanding(probe, item, policy);
    const transfer = src.transferFileTo.bind(src);
    return writeUnderPolicy(context, probe, policy, landing, (name, overwrite) => {
      // Until the destination says anything, an error is the source's.
      context.side = "source";
      return transfer(dest, sourcePath, dir, {
        name,
        overwrite,
        signal,
        onProgress: (progress) => {
          context.side = "destination";
          if (progress.phase === "outcome_unknown") context.dispatchedName = name;
          context.progress(progress);
        },
      });
    });
  }

  /** The name of the folder an item goes into, as a person reads it. */
  function folderLabelOf(batch: TransferBatch, item: TransferItem): string {
    const parents = landedParents(item, foldersOf(batch));
    return parents.at(-1) ?? batch.destLabel;
  }

  function hostNameOf(context: RunContext): string {
    const { batch } = context;
    return context.side === "source" && batch.source ? batch.source.name : batch.destination.name;
  }

  function failureCopy(context: RunContext, error: unknown): string {
    const { batch, item } = context;
    const copy = transferErrorCopy(codeOf(error), {
      name: item.name,
      hostName: hostNameOf(context),
      folderLabel: folderLabelOf(batch, item),
      side: context.side,
    });
    if (copy) return copy;
    return error instanceof Error && error.message.trim()
      ? error.message
      : `SPAWN D couldn't send “${item.name}” to ${batch.destination.name}.`;
  }

  /** A batch with nothing left to run keeps its route's speed for the next one. */
  function settleBatch(batchId: string): void {
    const batch = store.getState().batches.find((candidate) => candidate.id === batchId);
    if (!batch || !isSettledBatch(batch)) return;
    const pace = paces.get(batchId);
    paces.delete(batchId);
    if (!pace || pace.moved < RATE_MIN_BYTES || pace.activeMs < RATE_MIN_MS) return;
    const route = routeKey(
      [batch.source, batch.destination].flatMap((host) => (host ? [host.id] : [])),
    );
    store.getState().rememberRate(route, pace.moved / (pace.activeMs / 1000));
  }

  async function runOne(batch: TransferBatch, item: TransferItem): Promise<void> {
    const controller = new AbortController();
    const running: Running = { batchId: batch.id, itemId: item.id, controller, reason: null };
    current = running;
    const epoch = options.backgroundEpoch();
    const startedAt = now();
    patch(batch.id, item.id, {
      state: "running",
      phase: null,
      transferred: 0,
      startedAt,
      streamStartedAt: null,
      error: null,
      outcome: null,
      savedAs: null,
      clash: null,
      interruption: null,
    });
    const context: RunContext = {
      batch,
      item,
      signal: controller.signal,
      side: batch.kind === "send" ? "source" : "destination",
      dispatchedName: null,
      progress: progressReporter(batch.id, item.id, controller.signal),
    };
    const pace = paceOf(batch.id);
    try {
      const settled =
        item.kind === "folder"
          ? await runFolder(context)
          : batch.kind === "upload"
            ? await runUpload(context)
            : await runSend(context);
      if (settled.state === "done") {
        const total = store
          .getState()
          .batches.find((candidate) => candidate.id === batch.id)
          ?.items.find((candidate) => candidate.id === item.id)?.total;
        patch(batch.id, item.id, {
          state: "done",
          phase: "complete",
          transferred: total ?? 0,
          outcome: settled.outcome,
          savedAs: settled.savedAs,
          unconfirmed: null,
        });
        if (item.kind === "file") {
          pace.base += total ?? 0;
          pace.moved = pace.base;
          pace.activeMs += now() - startedAt;
        }
      } else if (settled.state === "conflict") {
        patch(batch.id, item.id, { state: "conflict", phase: null, clash: settled.clash });
      } else {
        patch(batch.id, item.id, { state: "skipped", phase: null });
        // A folder left out leaves out everything in it.
        if (item.kind === "folder") {
          store.getState().settleInside(batch.id, item.relative, { state: "skipped" });
        }
      }
    } catch (error) {
      if (running.reason !== null) {
        patch(batch.id, item.id, { state: "cancelled", phase: null });
        return;
      }
      const dispatched =
        context.dispatchedName ?? (codeOf(error) === "outcome_unknown" ? item.name : null);
      const unconfirmed = item.kind === "file" && dispatched ? { name: dispatched } : null;
      if (options.backgroundEpoch() !== epoch || !options.appActive()) {
        // Cut off by the phone, not refused by a host: it goes again on Resume.
        const interruption = { cause: "background" } as const;
        store.getState().pause(interruption);
        patch(batch.id, item.id, { state: "interrupted", phase: null, unconfirmed, interruption });
        return;
      }
      if (isLostTouch(error)) {
        // The connection went with the app on screen: the same pause, so the
        // rest of the queue does not fail one file at a time behind it.
        const interruption = { cause: "lost-touch", host: hostNameOf(context) } as const;
        store.getState().pause(interruption);
        patch(batch.id, item.id, { state: "interrupted", phase: null, unconfirmed, interruption });
        return;
      }
      const reason = failureCopy(context, error);
      patch(batch.id, item.id, { state: "failed", phase: null, error: reason, unconfirmed });
      // A folder that cannot be made fails what it would have held.
      if (item.kind === "folder") {
        store.getState().settleInside(batch.id, item.relative, { state: "failed", error: reason });
      }
    } finally {
      if (current === running) current = null;
      settleBatch(batch.id);
      options.onItemSettled?.(batch.id, item.id);
    }
  }

  async function loop(): Promise<void> {
    if (looping) return;
    looping = true;
    try {
      while (!disposed && options.appActive()) {
        const next = nextQueuedItem(store.getState());
        if (!next) break;
        await runOne(next.batch, next.item);
      }
    } finally {
      looping = false;
    }
  }

  const unsubscribe = store.subscribe((state) => {
    const running = current;
    if (running && running.reason === null) {
      const batch = state.batches.find((candidate) => candidate.id === running.batchId);
      if (!batch || batch.cancelled) {
        running.reason = "cancel";
        running.controller.abort();
      }
    }
    if (!looping && !disposed && nextQueuedItem(state)) void loop();
  });

  return {
    kick() {
      if (!disposed) void loop();
    },
    dispose() {
      disposed = true;
      unsubscribe();
      if (current) {
        current.reason = "dispose";
        current.controller.abort();
      }
    },
  };
}
