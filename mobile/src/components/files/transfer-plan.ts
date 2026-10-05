import type { DirectoryListing } from "@/components/files/listing";
import { joinDirectory, type PathFlavor } from "@/components/files/paths";
import { HOST_TRANSFER_MAX_BYTES } from "@/components/files/transfer";
import type { HostDirEntry } from "@/components/files/types";
import type { ConnectionInfo } from "@/terminal/transport/types";

/**
 * What a transfer does before it moves a byte: what is under what was picked,
 * the name each picked item lands under, and whether the trip is relayed and
 * long enough to say so first. Pure, and shared in meaning with the web file
 * browser (web/src/lib/files/transfer-plan.ts): the same four answers to a
 * taken name, decided per picked item, and the same kept-both names.
 */

/**
 * What a transfer does with a picked item whose name is already taken where
 * it is going. "ask" stops for an answer, and is what a send starts with.
 */
export type ConflictPolicy = "ask" | "keep_both" | "replace" | "skip";
/** One answer to a taken name. */
export type ConflictDecision = Exclude<ConflictPolicy, "ask">;

export const CONFLICT_POLICIES: readonly ConflictPolicy[] = ["ask", "keep_both", "replace", "skip"];

/**
 * A relayed transfer bigger than this is said before it starts (OD3: "warn
 * above 100 MB"). Measured in the units the app shows sizes in, so "100 MB"
 * on screen is this.
 */
export const RELAY_WARNING_BYTES = 100 * 1024 * 1024;

/** A time is only worth saying once it is longer than this (OD3). */
export const ESTIMATE_AFTER_SECONDS = 15;

/**
 * The most items — files and folders — one send walks. Past it the send is
 * refused whole rather than sent in part: a half-copied tree that looks
 * finished is worse than "pick a smaller folder".
 */
export const SEND_ITEM_LIMIT = 10_000;

/** Folders deeper than this are a link loop the host did not describe, or a mistake. */
export const SEND_DEPTH_LIMIT = 64;

/** Names tried for a kept-both copy before the transfer gives up on finding one. */
export const KEEP_BOTH_ATTEMPTS = 99;

// ---- Names ------------------------------------------------------------------

/** Extensions that are one extension to a person: "logs.tar.gz" keeps ".tar.gz". */
const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz", ".tar.lzma"];

/** "notes.md" → ["notes", ".md"]; ".env" and "Makefile" have no extension. */
export function splitExtension(name: string): [string, string] {
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound) && name.length > compound.length) {
      return [name.slice(0, -compound.length), name.slice(-compound.length)];
    }
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * The name a kept-both copy takes: "notes (2).md", then "(3)"…, and
 * "logs (2).tar.gz". A folder keeps its whole name: "v1.2 (2)".
 */
export function keepBothName(name: string, copy: number, isDir = false): string {
  if (copy < 2) return name;
  const [stem, extension] = isDir ? [name, ""] : splitExtension(name);
  return `${stem} (${copy})${extension}`;
}

/**
 * The first of `name`, "name (2)", "name (3)"… that `taken` says is free, or
 * null when every one tried is taken.
 */
export async function firstFreeName(
  name: string,
  taken: (candidate: string) => Promise<boolean> | boolean,
  { isDir = false, attempts = KEEP_BOTH_ATTEMPTS }: { isDir?: boolean; attempts?: number } = {},
): Promise<string | null> {
  for (let copy = 1; copy <= attempts + 1; copy += 1) {
    const candidate = keepBothName(name, copy, isDir);
    if (!(await taken(candidate))) return candidate;
  }
  return null;
}

/** A case-insensitive view of the names in a folder: a free name is free on every host's disk. */
export function nameSet(names: Iterable<string>): { has(name: string): boolean } {
  const set = new Set<string>();
  for (const name of names) set.add(name.toLowerCase());
  return { has: (name) => set.has(name.toLowerCase()) };
}

// ---- Conflicts ----------------------------------------------------------------

/**
 * The answers a taken name offers: a file can be replaced, a folder merged
 * into the one there, and a file and a folder of the same name are never
 * swapped for each other.
 */
export function conflictChoices(isDir: boolean, clashIsDir: boolean): ConflictDecision[] {
  return isDir === clashIsDir ? ["replace", "keep_both", "skip"] : ["keep_both", "skip"];
}

/**
 * What an answer does to one item against what holds its name. "Replace"
 * never takes away what is there: between a file and a folder it becomes
 * "Keep both", the one answer that loses nothing.
 */
export function settleDecision(
  decision: ConflictDecision,
  isDir: boolean,
  clashIsDir: boolean,
): ConflictDecision {
  return decision === "replace" && isDir !== clashIsDir ? "keep_both" : decision;
}

// ---- The walk -------------------------------------------------------------------

/** One thing a send moves: a folder to make, or a file to copy. */
export interface PlannedItem {
  kind: "file" | "folder";
  /** Where it is on the source host, as that host spells it. */
  sourcePath: string;
  /** Where it goes below the destination folder, one name per level: the picked item's own name first. */
  relative: string[];
  /** What the source's listing said; the read's own declaration is the truth. */
  size: number | null;
}

/** Everything a send will do, worked out before it is offered. */
export interface SendPlan {
  /** Folders and files, every folder before what is in it, the picked items first. */
  items: PlannedItem[];
  files: number;
  folders: number;
  /** The sum of the sizes listed, for the relay warning and the estimate. */
  totalBytes: number;
  /** Links are never followed, so they are left out and counted. */
  links: number;
  /** Sockets, devices and the like: not files, so left out and counted. */
  special: number;
  /** Folders a v1 host listed only in part, below the folder sent from. */
  truncated: string[];
  /** Files over the per-file ceiling: refused, never queued. */
  tooLarge: PlannedItem[];
  /** The picked item whose walk passed {@link SEND_ITEM_LIMIT} or {@link SEND_DEPTH_LIMIT}: the send is refused. */
  tooMany: string | null;
}

export interface PlanSendOptions {
  /** The items picked, all in one folder of the source host. */
  entries: readonly HostDirEntry[];
  /** Every page of a folder, to the host's own limit. */
  listFolder(path: string): Promise<DirectoryListing>;
  signal?: AbortSignal;
  /** Called as the walk finds items, so a long one can say how far it has got. */
  onProgress?(counted: number): void;
  itemLimit?: number;
  maxFileBytes?: number;
}

function aborted(): Error & { code: string } {
  return Object.assign(new Error("Cancelled."), { code: "cancelled" });
}

function entryKind(entry: HostDirEntry): "folder" | "file" | "link" | "other" {
  if (entry.kind === "symlink") return "link";
  if (entry.is_dir || entry.kind === "directory") return "folder";
  if (entry.kind === "file" || entry.kind === undefined) return "file";
  return "other";
}

/**
 * Walks what was picked, breadth first, and lists what a send would carry.
 * Links are never followed — a send of a folder never leaves it — and a
 * folder the host lists only in part is named, so the person is told before
 * anything is sent that its tail is not coming. An empty folder is sent as
 * the empty folder it is.
 */
export async function planSend({
  entries,
  listFolder,
  signal,
  onProgress,
  itemLimit = SEND_ITEM_LIMIT,
  maxFileBytes = HOST_TRANSFER_MAX_BYTES,
}: PlanSendOptions): Promise<SendPlan> {
  const plan: SendPlan = {
    items: [],
    files: 0,
    folders: 0,
    totalBytes: 0,
    links: 0,
    special: 0,
    truncated: [],
    tooLarge: [],
    tooMany: null,
  };
  const queue: { path: string; relative: string[] }[] = [];
  let counted = 0;

  /** Takes one entry; false once the walk must stop. */
  const take = (entry: HostDirEntry, parent: string[]): boolean => {
    const relative = [...parent, entry.name];
    const kind = entryKind(entry);
    if (kind === "link") {
      plan.links += 1;
      return true;
    }
    if (kind === "other") {
      plan.special += 1;
      return true;
    }
    if (counted >= itemLimit || relative.length > SEND_DEPTH_LIMIT) {
      plan.tooMany = relative[0] ?? entry.name;
      return false;
    }
    counted += 1;
    if (kind === "folder") {
      plan.items.push({ kind, sourcePath: entry.path, relative, size: null });
      plan.folders += 1;
      queue.push({ path: entry.path, relative });
      return true;
    }
    const file: PlannedItem = {
      kind,
      sourcePath: entry.path,
      relative,
      size: typeof entry.size === "number" ? entry.size : null,
    };
    if (file.size !== null && file.size > maxFileBytes) {
      plan.tooLarge.push(file);
      return true;
    }
    plan.items.push(file);
    plan.files += 1;
    plan.totalBytes += file.size ?? 0;
    return true;
  };

  for (const entry of entries) {
    if (!take(entry, [])) return plan;
  }
  onProgress?.(counted);
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (signal?.aborted) throw aborted();
    const listing = await listFolder(next.path);
    if (signal?.aborted) throw aborted();
    if (listing.truncated) plan.truncated.push(next.relative.join("/"));
    for (const entry of listing.entries) {
      if (!take(entry, next.relative)) return plan;
    }
    onProgress?.(counted);
  }
  return plan;
}

/** A destination path for a file or folder `relative` below `folder`, in the destination's spelling. */
export function destinationPath(folder: string, relative: readonly string[], flavor: PathFlavor) {
  return relative.reduce((path, name) => joinDirectory(path, name, flavor), folder);
}

// ---- Time and the relay (OD3) ---------------------------------------------------------

/** The hosts, by name, whose connection to this device goes through the relay. */
export function relayedHosts(
  legs: readonly { name: string; info: ConnectionInfo | null | undefined }[],
): string[] {
  return legs.filter((leg) => leg.info?.kind === "relay").map((leg) => leg.name);
}

/** Whether a transfer is said to go through the relay before it starts (OD3: above 100 MB). */
export function needsRelayWarning(totalBytes: number, relayed: readonly string[]): boolean {
  return relayed.length > 0 && totalBytes > RELAY_WARNING_BYTES;
}

/**
 * What one leg moves before anything has been measured: a v1 host stream
 * keeps eight 8 KiB chunks unacknowledged, so it carries about 64 KiB per
 * round trip (S4 measured 1.22 MB/s at 55 ms, which this predicts).
 */
export function modelRate(rttMs: number | null | undefined): number {
  const rtt = typeof rttMs === "number" && Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 50;
  return (8 * 8 * 1024) / (Math.max(rtt, 5) / 1000);
}

/** The key a route's last measured speed is kept under: the hosts it touches. */
export function routeKey(hostIds: readonly string[]): string {
  return [...hostIds].sort().join("|");
}

/**
 * The speed to expect before anything is measured: what this route did last
 * time, or the round-trip model of its slowest leg (a send crosses two legs
 * one after the other, so the slower one sets the pace).
 */
export function expectedRate(
  legs: readonly { hostId: string; info: ConnectionInfo | null | undefined }[],
  remembered: Readonly<Record<string, number>>,
): number {
  const known = remembered[routeKey(legs.map((leg) => leg.hostId))];
  if (known && known > 0) return known;
  return Math.min(...legs.map((leg) => modelRate(leg.info?.rttMs)));
}

/** Seconds left, or null when there is nothing to go on. */
export function estimateSeconds(
  remainingBytes: number,
  bytesPerSecond: number | null,
): number | null {
  if (bytesPerSecond === null || !(bytesPerSecond > 0) || !(remainingBytes >= 0)) return null;
  return remainingBytes / bytesPerSecond;
}

/** Only a wait longer than {@link ESTIMATE_AFTER_SECONDS} is worth a sentence. */
export function worthEstimating(seconds: number | null): seconds is number {
  return seconds !== null && seconds > ESTIMATE_AFTER_SECONDS;
}

/**
 * A running speed: bytes over the last few seconds, so a stall shows and an
 * early burst does not promise what the rest will not keep.
 */
export class RateMeter {
  private readonly samples: { at: number; bytes: number }[] = [];

  constructor(private readonly windowMs = 5_000) {}

  note(at: number, totalBytes: number): void {
    this.samples.push({ at, bytes: totalBytes });
    while (this.samples.length > 2 && at - (this.samples[0]?.at ?? at) > this.windowMs) {
      this.samples.shift();
    }
  }

  /** Bytes per second over the window, or null before a second of samples. */
  rate(): number | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last.at - first.at < 1_000) return null;
    return (last.bytes - first.bytes) / ((last.at - first.at) / 1000);
  }

  reset(): void {
    this.samples.length = 0;
  }
}
