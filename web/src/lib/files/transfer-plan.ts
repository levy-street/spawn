/**
 * What a transfer will do before it moves a byte: the files and folders under
 * what was picked, what is already at the destination, the name each item
 * lands under, and whether the trip is long enough or relayed enough to say
 * so first. Pure — listings come through a page fetcher passed in — and
 * shared in meaning with the phone (mobile/src/components/files).
 */

import type { HostDirEntry } from "@/lib/hostControl";
import { drainDirectory, type FetchPage } from "./listing";

/** What happens to an item whose name is already taken at the destination. */
export type ConflictPolicy = "ask" | "keep-both" | "replace" | "skip";
/** One answer, for one item (or, with "the others too", for the rest). */
export type ConflictDecision = "keep-both" | "replace" | "skip";

export const CONFLICT_POLICIES: readonly ConflictPolicy[] = ["ask", "keep-both", "replace", "skip"];

/**
 * The most items one transfer will walk. A folder past this is refused whole
 * rather than sent in part: a half-copied tree that looks finished is worse
 * than a clear "send a smaller folder".
 */
export const MAX_TRANSFER_ITEMS = 10_000;
/** Deeper than this is a link loop the host did not describe, or a mistake. */
export const MAX_TRANSFER_DEPTH = 64;
/** The host's own ceiling on one file (daemon/src/host_files.rs MAX_FILE_BYTES). */
export const MAX_TRANSFER_FILE_BYTES = 512 * 1024 * 1024;
/** OD3: a relayed transfer bigger than this asks first. */
export const RELAY_WARNING_BYTES = 100 * 1024 * 1024;
/** OD3: a time is only worth saying once it is longer than this. */
export const ESTIMATE_AFTER_SECONDS = 15;

/** Raised by a walk that would pass `MAX_TRANSFER_ITEMS`. */
export class TransferTooLargeError extends Error {
  constructor(readonly root: string) {
    super(`More than ${MAX_TRANSFER_ITEMS} items under ${root}`);
    this.name = "TransferTooLargeError";
  }
}

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
 * The name "Keep both" gives the newcomer: "notes (2).md", then "(3)"… —
 * the first not in `taken`. A folder keeps its whole name ("v1.2 (2)").
 * Compared without case, so a free name is free on every host's filesystem.
 */
export function keepBothName(
  name: string,
  taken: (candidate: string) => boolean,
  isDir = false,
): string {
  const [stem, extension] = isDir ? [name, ""] : splitExtension(name);
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

/** A case-insensitive view of the names in a folder. */
export function nameSet(names: Iterable<string>): {
  has(name: string): boolean;
  add(name: string): void;
} {
  const set = new Set<string>();
  for (const name of names) set.add(name.toLowerCase());
  return {
    has: (name) => set.has(name.toLowerCase()),
    add: (name) => {
      set.add(name.toLowerCase());
    },
  };
}

// ---- Conflicts ----------------------------------------------------------------

export interface TopItem {
  name: string;
  isDir: boolean;
}

export interface ExistingItem {
  name: string;
  isDir: boolean;
}

/** Where a top-level item lands, once any conflict is settled. */
export interface Landing {
  /** The name it is written under. */
  name: string;
  /** Left out: "Skip" on a name already there. */
  skip: boolean;
  /** A file written over what is there ("Replace"). */
  overwrite: boolean;
  /** A folder written into the one already there ("Replace" on a folder merges). */
  merge: boolean;
}

/** The item at the destination with this exact name, if any. */
export function existingFor(
  item: TopItem,
  existing: ReadonlyMap<string, ExistingItem>,
): ExistingItem | null {
  return existing.get(item.name) ?? null;
}

/**
 * Settle one top-level item against what is at the destination.
 *
 * "Replace" never takes a folder away: a folder is merged into the one there
 * (files with the same name replaced, nothing else touched), and a file and a
 * folder of the same name are never swapped for each other — that becomes
 * "Keep both", the one answer that loses nothing.
 */
export function landingFor(
  item: TopItem,
  clash: ExistingItem | null,
  decision: ConflictDecision | null,
  taken: { has(name: string): boolean },
): Landing {
  const plain = { name: item.name, skip: false, overwrite: false, merge: false };
  if (!clash) return plain;
  const choice: ConflictDecision =
    decision === "replace" && clash.isDir !== item.isDir ? "keep-both" : (decision ?? "keep-both");
  if (choice === "skip") return { ...plain, skip: true };
  if (choice === "replace")
    return item.isDir ? { ...plain, merge: true } : { ...plain, overwrite: true };
  return { ...plain, name: keepBothName(item.name, (name) => taken.has(name), item.isDir) };
}

/** The answers a conflict question offers: a file can be replaced, a folder merged. */
export function conflictChoices(item: TopItem, clash: ExistingItem): ConflictDecision[] {
  return clash.isDir === item.isDir ? ["replace", "keep-both", "skip"] : ["keep-both", "skip"];
}

// ---- The walk -------------------------------------------------------------------

/** One thing a transfer moves: a folder to make, or a file to copy. */
export interface WalkedItem {
  /** Path components from the transfer's root: the picked item's own name first. */
  rel: string[];
  kind: "dir" | "file";
  /** Where it is on the source host. */
  path: string;
  size: number;
  modified: number | null;
}

export interface WalkResult {
  items: WalkedItem[];
  /** Symbolic links left out (SPAWN D never follows one). */
  links: number;
  /** Sockets, devices and the like, left out. */
  others: number;
  /** Folders the host stopped listing at its cap: displayed paths. */
  truncated: string[];
}

export interface WalkSource {
  path: string;
  name: string;
  isDir: boolean;
  /**
   * What the host listed it as, when it said. A link or a special file picked
   * directly is skipped and counted, as one met inside a folder is.
   */
  kind?: SourceKind;
  size?: number | null;
  modified?: number | null;
}

export type SourceKind = "dir" | "file" | "link" | "other";

/** What a picked item is: its listed kind, else read from `isDir`. */
export function sourceKind(source: WalkSource): SourceKind {
  return source.kind ?? (source.isDir ? "dir" : "file");
}

/** A listed entry as a transfer reads it. */
export function entryKind(entry: HostDirEntry): SourceKind {
  if (entry.kind === "symlink") return "link";
  if (entry.is_dir || entry.kind === "directory") return "dir";
  // An entry that does not say is read by `is_dir`, as the file list reads it.
  if (entry.kind === "file" || entry.kind === undefined) return "file";
  return "other";
}

/** A listed entry as a transfer source. */
export function walkSourceOf(entry: HostDirEntry): WalkSource {
  return {
    path: entry.path,
    name: entry.name,
    isDir: entryKind(entry) === "dir",
    kind: entryKind(entry),
    size: entry.size ?? null,
    modified: entry.modified_at ?? null,
  };
}

/**
 * Everything under the picked items, parents before children, each folder's
 * children in name order. Links and special files — picked, or met inside a
 * folder — are counted and left out; a folder the host cut short at its cap is
 * named in `truncated`.
 */
export async function walkHostItems(
  fetchPage: FetchPage,
  sources: readonly WalkSource[],
  {
    signal,
    onProgress,
    limit = MAX_TRANSFER_ITEMS,
  }: { signal?: AbortSignal; onProgress?: (count: number) => void; limit?: number } = {},
): Promise<WalkResult> {
  const result: WalkResult = { items: [], links: 0, others: 0, truncated: [] };
  const push = (item: WalkedItem, root: string) => {
    if (result.items.length >= limit) throw new TransferTooLargeError(root);
    result.items.push(item);
    if (result.items.length % 50 === 0) onProgress?.(result.items.length);
  };
  const visit = async (dirPath: string, rel: string[], root: string): Promise<void> => {
    if (signal?.aborted) throw new DOMException("Transfer cancelled", "AbortError");
    if (rel.length > MAX_TRANSFER_DEPTH) throw new TransferTooLargeError(root);
    const listing = await drainDirectory(fetchPage, dirPath, { signal });
    if (listing.truncated) result.truncated.push(rel.join("/"));
    const children = [...listing.entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const child of children) {
      const kind = entryKind(child);
      if (kind === "link") {
        result.links += 1;
        continue;
      }
      if (kind === "other") {
        result.others += 1;
        continue;
      }
      const childRel = [...rel, child.name];
      push(
        {
          rel: childRel,
          kind,
          path: child.path,
          size: kind === "file" ? Math.max(0, child.size ?? 0) : 0,
          modified: child.modified_at ?? null,
        },
        root,
      );
      if (kind === "dir") await visit(child.path, childRel, root);
    }
  };
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException("Transfer cancelled", "AbortError");
    const kind = sourceKind(source);
    if (kind === "link") {
      result.links += 1;
      continue;
    }
    if (kind === "other") {
      result.others += 1;
      continue;
    }
    if (kind === "dir") {
      push(
        {
          rel: [source.name],
          kind: "dir",
          path: source.path,
          size: 0,
          modified: source.modified ?? null,
        },
        source.name,
      );
      await visit(source.path, [source.name], source.name);
    } else {
      push(
        {
          rel: [source.name],
          kind: "file",
          path: source.path,
          size: Math.max(0, source.size ?? 0),
          modified: source.modified ?? null,
        },
        source.name,
      );
    }
  }
  onProgress?.(result.items.length);
  return result;
}

/** The bytes a list of walked items will move. */
export function totalBytes(items: ReadonlyArray<{ kind: "dir" | "file"; size: number }>): number {
  let total = 0;
  for (const item of items) if (item.kind === "file") total += item.size;
  return total;
}

// ---- Local files (uploads) ------------------------------------------------------

export interface LocalItem {
  /** "/"-separated path under the folder being uploaded into. */
  rel: string;
  file: File;
}

/**
 * The folders an upload has to make, parents first, from the files' relative
 * paths plus any empty folders the picker reported.
 */
export function uploadFolders(
  items: readonly LocalItem[],
  emptyDirs: readonly string[] = [],
): string[] {
  const dirs = new Set<string>();
  const add = (parts: string[]) => {
    for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const item of items) add(splitRel(item.rel).slice(0, -1));
  for (const dir of emptyDirs) add(splitRel(dir));
  return [...dirs].sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** A relative path's components, with nothing that climbs or roots. */
export function splitRel(rel: string): string[] {
  return rel.split(/[\\/]/u).filter((part) => part !== "" && part !== "." && part !== "..");
}

/** The top-level items of an upload: each first component, a folder if anything is under it. */
export function uploadTopItems(
  items: readonly LocalItem[],
  emptyDirs: readonly string[] = [],
): TopItem[] {
  const top = new Map<string, boolean>();
  for (const item of items) {
    const parts = splitRel(item.rel);
    const first = parts[0];
    if (!first) continue;
    top.set(first, (top.get(first) ?? false) || parts.length > 1);
  }
  for (const dir of emptyDirs) {
    const first = splitRel(dir)[0];
    if (first) top.set(first, true);
  }
  return [...top].map(([name, isDir]) => ({ name, isDir }));
}

/**
 * The picked item an upload passes `limit` at, counting files and folders as
 * a send's walk does, or null when it fits.
 */
export function uploadOverLimit(
  items: readonly LocalItem[],
  emptyDirs: readonly string[] = [],
  limit = MAX_TRANSFER_ITEMS,
): string | null {
  const perTop = new Map<string, number>();
  const add = (parts: string[]) => {
    const first = parts[0];
    if (first) perTop.set(first, (perTop.get(first) ?? 0) + 1);
  };
  for (const item of items) add(splitRel(item.rel));
  for (const dir of uploadFolders(items, emptyDirs)) add(splitRel(dir));
  let total = 0;
  for (const [name, count] of perTop) {
    total += count;
    if (total > limit) return name;
  }
  return null;
}

// ---- Time and the relay (OD3) ---------------------------------------------------------

export type PathKind = "direct" | "stun" | "relay" | null;

/** The hosts, among a transfer's legs, reached through the TURN relay. */
export function relayedHosts(legs: ReadonlyArray<{ name: string; kind: PathKind }>): string[] {
  return legs.filter((leg) => leg.kind === "relay").map((leg) => leg.name);
}

/** OD3: say so before a relayed transfer of more than 100 MB. */
export function needsRelayWarning(
  bytes: number,
  legs: ReadonlyArray<{ name: string; kind: PathKind }>,
): boolean {
  return bytes > RELAY_WARNING_BYTES && relayedHosts(legs).length > 0;
}

/**
 * What one leg moves before anything has been measured: a v1 host stream
 * keeps eight 8 KiB chunks unacknowledged, so it carries about 64 KiB per
 * round trip.
 */
export function modelRate(rttMs: number | null | undefined): number {
  const rtt = typeof rttMs === "number" && Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 50;
  return (8 * 8 * 1024) / (Math.max(rtt, 5) / 1000);
}

/** Seconds left, or null when there is nothing to go on. */
export function estimateSeconds(remainingBytes: number, bytesPerSecond: number): number | null {
  if (!(bytesPerSecond > 0) || !(remainingBytes >= 0)) return null;
  return remainingBytes / bytesPerSecond;
}

/** Only a wait longer than `ESTIMATE_AFTER_SECONDS` is worth a sentence. */
export function worthEstimating(seconds: number | null): seconds is number {
  return seconds !== null && seconds > ESTIMATE_AFTER_SECONDS;
}

/**
 * A running speed: bytes over the last few seconds, so a stall shows and an
 * early burst does not promise what the rest will not keep.
 */
export class RateMeter {
  private readonly samples: Array<{ at: number; bytes: number }> = [];

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
