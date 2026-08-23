/**
 * The store behind every preview.
 *
 * Not TanStack Query, for one decisive reason: object URLs must be revoked, and
 * `gcTime` gives no deterministic hook to revoke them on. What is needed here is
 * refcounting (a URL stays alive exactly as long as something renders it),
 * cancellation (a superseded hover must stop pulling bytes), and single-flight
 * dedupe. That is a different job from caching JSON, so it is a different store.
 *
 * The cache also owns the *pump*, not React. If a component unmounted mid-stream
 * and nobody drained the reader, the stream would sit there for a full minute
 * holding one of the host's eight long-task permits — the file tree would go
 * quiet and nothing would explain why.
 *
 * Browser I/O is injected so `bun test` can assert revocation with no DOM.
 */

export type PreviewVariant = "thumb" | "head" | "full";

export type PreviewReady = {
  status: "ready";
  mime: string;
  bytes: number;
  /** Object URL for binary content; null for text. */
  url: string | null;
  /** Decoded text for text content; null for binary. */
  text: string | null;
  truncated: boolean;
  width?: number;
  height?: number;
};

export type PreviewEntry =
  | { status: "loading"; received: number; total: number }
  | PreviewReady
  | { status: "error"; code: string; message: string };

export type PreviewLoaderContext = {
  signal: AbortSignal;
  onProgress: (received: number, total: number) => void;
};

export type PreviewLoader = (
  context: PreviewLoaderContext,
) => Promise<Omit<PreviewReady, "status">>;

export type PreviewPriority = "hover" | "modal";

export const PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;
export const PREVIEW_CACHE_ENTRIES = 32;

type CacheIo = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  now: () => number;
};

let io: CacheIo = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => {
    URL.revokeObjectURL(url);
  },
  now: () => Date.now(),
};

/**
 * Mint an object URL through the same indirection the cache revokes with, so a
 * configured test double sees both halves of the lifetime.
 */
export function createPreviewObjectUrl(blob: Blob): string {
  return io.createObjectURL(blob);
}

/** Test seam. Also resets the store so cases cannot leak into each other. */
export function configurePreviewCache(next: Partial<CacheIo>): void {
  io = { ...io, ...next };
  records.clear();
  hosts.clear();
  listeners.clear();
}

type CacheRecord = {
  key: string;
  hostId: string;
  entry: PreviewEntry;
  refs: number;
  bytes: number;
  lastUsed: number;
  controller: AbortController | null;
  priority: PreviewPriority;
};

type HostQueue = {
  running: string | null;
  queued: { key: string; start: () => void; priority: PreviewPriority } | null;
};

const records = new Map<string, CacheRecord>();
const hosts = new Map<string, HostQueue>();
const listeners = new Set<() => void>();

/** Field separator. A newline cannot appear in a host path component. */
const SEPARATOR = "\n";

export function previewKey(input: {
  hostId: string;
  path: string;
  modifiedAt: number | null | undefined;
  size: number | null | undefined;
  variant: PreviewVariant;
}): string {
  // mtime and size are part of the identity, so an edited file misses the
  // cache for free and a stale preview simply cannot be served.
  return [
    input.hostId,
    input.path,
    String(input.modifiedAt ?? ""),
    String(input.size ?? ""),
    input.variant,
  ].join(SEPARATOR);
}

function emit() {
  for (const listener of listeners) listener();
}

function queueFor(hostId: string): HostQueue {
  let queue = hosts.get(hostId);
  if (!queue) {
    queue = { running: null, queued: null };
    hosts.set(hostId, queue);
  }
  return queue;
}

function releaseUrl(url: string | null) {
  if (url) io.revokeObjectURL(url);
}

function disposeRecord(record: CacheRecord) {
  if (record.entry.status === "ready") releaseUrl(record.entry.url);
  record.controller?.abort();
  records.delete(record.key);
}

/**
 * Evict least-recently-used entries until the store is back inside its budget.
 *
 * Two things are never evicted. Anything currently rendered is pinned, because
 * evicting it would revoke a URL an `<img>` is still pointing at. And the entry
 * that just arrived is protected for this pass: a file larger than the whole
 * budget would otherwise be thrown away in the same tick it landed, so opening
 * a big image would fetch it and then immediately forget it.
 */
function evict(protectedKey?: string) {
  let total = 0;
  for (const record of records.values()) total += record.bytes;
  if (total <= PREVIEW_CACHE_BYTES && records.size <= PREVIEW_CACHE_ENTRIES) return;

  const candidates = [...records.values()]
    .filter(
      (record) =>
        record.key !== protectedKey && record.refs === 0 && record.entry.status !== "loading",
    )
    .sort((a, b) => a.lastUsed - b.lastUsed);

  for (const record of candidates) {
    if (total <= PREVIEW_CACHE_BYTES && records.size <= PREVIEW_CACHE_ENTRIES) break;
    total -= record.bytes;
    disposeRecord(record);
  }
}

function settle(key: string, entry: PreviewEntry, bytes: number) {
  const record = records.get(key);
  if (!record) return;
  record.entry = entry;
  record.bytes = bytes;
  record.controller = null;
  record.lastUsed = io.now();
  evict(key);
  emit();
}

function runNext(hostId: string) {
  const queue = queueFor(hostId);
  queue.running = null;
  const next = queue.queued;
  queue.queued = null;
  if (next) next.start();
}

function describe(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object" && "code" in error) {
    const coded = error as { code?: unknown; message?: unknown };
    return {
      code: typeof coded.code === "string" ? coded.code : "preview_failed",
      message: typeof coded.message === "string" ? coded.message : "Preview failed",
    };
  }
  return {
    code: "preview_failed",
    message: error instanceof Error ? error.message : "Preview failed",
  };
}

export const previewCache = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  peek(key: string): PreviewEntry | undefined {
    return records.get(key)?.entry;
  },

  /**
   * Start loading `key` unless it is already loaded or in flight.
   *
   * At most one preview streams per host at a time. That is not politeness: the
   * host has eight long-task permits shared with reads, writes and transfers,
   * and a preview holding one for tens of seconds is the difference between
   * "previews are slow" and "the file tree is broken".
   */
  request(
    key: string,
    loader: PreviewLoader,
    options: { hostId: string; priority?: PreviewPriority },
  ): void {
    const existing = records.get(key);
    if (existing) {
      existing.lastUsed = io.now();
      return;
    }
    const hostId = options.hostId;
    const priority = options.priority ?? "hover";
    const record: CacheRecord = {
      key,
      hostId,
      entry: { status: "loading", received: 0, total: 0 },
      refs: 0,
      bytes: 0,
      lastUsed: io.now(),
      controller: null,
      priority,
    };
    records.set(key, record);
    emit();

    const start = () => {
      const live = records.get(key);
      if (!live) return;
      const queue = queueFor(hostId);
      queue.running = key;
      const controller = new AbortController();
      live.controller = controller;
      loader({
        signal: controller.signal,
        onProgress: (received, total) => {
          const current = records.get(key);
          if (!current || current.entry.status !== "loading") return;
          current.entry = { status: "loading", received, total };
          emit();
        },
      })
        .then((ready) => {
          if (!records.has(key)) {
            releaseUrl(ready.url);
            return;
          }
          settle(key, { status: "ready", ...ready }, ready.bytes);
        })
        .catch((error: unknown) => {
          if (!records.has(key)) return;
          if (controller.signal.aborted) {
            // Superseded, not failed: drop it so a later request retries.
            records.delete(key);
            emit();
            return;
          }
          settle(key, { status: "error", ...describe(error) }, 0);
        })
        .finally(() => {
          if (queueFor(hostId).running === key) runNext(hostId);
        });
    };

    const queue = queueFor(hostId);
    if (queue.running === null) {
      start();
      return;
    }
    // A modal is a deliberate act and outranks a hover that is merely in the
    // way; a hover never pre-empts anything.
    const running = records.get(queue.running);
    if (priority === "modal" && running && running.priority === "hover") {
      running.controller?.abort();
    }
    if (queue.queued && queue.queued.priority === "modal" && priority === "hover") return;
    if (queue.queued) records.delete(queue.queued.key);
    queue.queued = { key, start, priority };
    emit();
  },

  acquire(key: string): void {
    const record = records.get(key);
    if (!record) return;
    record.refs += 1;
    record.lastUsed = io.now();
  },

  releaseRef(key: string): void {
    const record = records.get(key);
    if (!record) return;
    record.refs = Math.max(0, record.refs - 1);
    record.lastUsed = io.now();
  },

  cancel(key: string): void {
    const record = records.get(key);
    if (!record) return;
    record.controller?.abort();
    if (record.entry.status === "loading") records.delete(key);
    emit();
  },

  /** Drop everything for one host — on disconnect, or when the tree unmounts. */
  clearHost(hostId: string): void {
    for (const record of [...records.values()]) {
      if (record.hostId === hostId) disposeRecord(record);
    }
    hosts.delete(hostId);
    emit();
  },

  /** Introspection for tests. */
  size(): number {
    return records.size;
  },
};
