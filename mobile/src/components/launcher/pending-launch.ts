import { secureStorage } from "@/lib/secure-storage";

const STORAGE_PREFIX = "spawn.pendingLaunch";
const CHUNK_BYTES = 1_536;
export const PENDING_LAUNCH_TTL_MS = 15 * 60 * 1_000;
/** How long a provisional record waits to be confirmed before it is stale:
 *  longer than a commit and its retries take, far shorter than the TTL. */
export const PENDING_LAUNCH_PROVISIONAL_MS = 3 * 60 * 1_000;

/**
 * A command waiting to be typed into a window's fresh shell.
 *
 * It belongs to one incarnation of the window, `${sessionId}@${hostId}` — the
 * shell on the host it was queued for. Typed into that incarnation or into
 * nothing: once a terminal is attached to the window on another host the
 * command is dropped, never typed there, and one nobody typed within
 * {@link PENDING_LAUNCH_TTL_MS} lapses. The browser keeps the same rules
 * (`web/src/components/workspace/pending-launch.ts`).
 */
export interface PendingLaunchRecord {
  sessionId: string;
  /** The host whose shell the command was queued for; null for a record an
   *  earlier version of the app saved, which named none. */
  hostId: string | null;
  command: string;
  createdAt: number;
  expiresAt: number;
}

interface PendingManifest extends Omit<PendingLaunchRecord, "command" | "hostId"> {
  version: 1;
  hostId?: string;
  generation: string;
  chunks: number;
  delivered: boolean;
  /** Written before the server has said the incarnation exists: nothing
   *  types it until `confirm`, and one never confirmed goes stale. */
  provisional?: boolean;
}

export interface PendingLaunchStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type PendingLaunchRead =
  | { status: "ready"; record: PendingLaunchRecord }
  | { status: "already_delivered" }
  | { status: "missing" }
  | { status: "stale" }
  /** Queued for the window as it ran on another host: dropped, not typed. */
  | { status: "elsewhere" }
  /** Queued ahead of a server answer that has not come yet: not typable
   *  until it is confirmed, and asked again. */
  | { status: "provisional" }
  | { status: "lost"; reason: "invalid_manifest" | "missing_chunk" };

export interface PendingLaunchStore {
  /** Queue `command` for the window as it runs on `hostId` — the host the
   *  caller just created, restarted or moved it on. A `provisional` record
   *  is written before the server has made that incarnation (a carried
   *  move's commit): nothing types it until `confirm`. */
  persist(
    sessionId: string,
    hostId: string,
    command: string,
    options?: { provisional?: boolean },
  ): Promise<PendingLaunchRecord>;
  /** The server made the incarnation a provisional record was queued for:
   *  it may be typed now. Nothing else is touched. */
  confirm?(sessionId: string, hostId: string): Promise<void>;
  /** The incarnation a provisional record was queued for will not be made
   *  by this device: the record goes. A confirmed one, or one queued for
   *  another host, is left alone. */
  discard?(sessionId: string, hostId: string): Promise<void>;
  /** Durably claims delivery, into the window as it runs on `hostId`, before
   *  exposing command bytes. */
  take(sessionId: string, hostId: string): Promise<PendingLaunchRead>;
  /** A terminal is attached to the window on `hostId`: a command queued for
   *  it as it ran anywhere else belongs to an incarnation that has gone, and
   *  is dropped. */
  observe?(sessionId: string, hostId: string): Promise<void>;
  complete?(sessionId: string): Promise<void>;
  abandon?(sessionId: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function manifestKeyIn(prefix: string, sessionId: string): string {
  return `${prefix}.${safeSessionId(sessionId)}`;
}

function chunkKeyIn(prefix: string, sessionId: string, generation: string, index: number): string {
  return `${manifestKeyIn(prefix, sessionId)}.${generation}.${index}`;
}

function utf8Bytes(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function chunkCommand(command: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of command) {
    const nextBytes = utf8Bytes(character);
    if (chunk && bytes + nextBytes > CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += nextBytes;
  }
  chunks.push(chunk);
  return chunks;
}

function isManifest(value: unknown): value is PendingManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === 1 &&
    typeof candidate["sessionId"] === "string" &&
    typeof candidate["createdAt"] === "number" &&
    typeof candidate["expiresAt"] === "number" &&
    (candidate["hostId"] === undefined || typeof candidate["hostId"] === "string") &&
    typeof candidate["generation"] === "string" &&
    Number.isInteger(candidate["chunks"]) &&
    Number(candidate["chunks"]) > 0 &&
    (candidate["delivered"] === undefined || typeof candidate["delivered"] === "boolean") &&
    (candidate["provisional"] === undefined || typeof candidate["provisional"] === "boolean")
  );
}

async function readManifest(
  storage: PendingLaunchStorage,
  sessionId: string,
  manifestKey: (sessionId: string) => string,
): Promise<PendingManifest | null | "invalid"> {
  const raw = await storage.get(manifestKey(sessionId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isManifest(parsed) && parsed.sessionId === sessionId
      ? { ...parsed, delivered: parsed.delivered ?? false }
      : "invalid";
  } catch {
    return "invalid";
  }
}

export function createPendingLaunchStore(
  storage: PendingLaunchStorage,
  options: {
    now?: () => number;
    ttlMs?: number;
    /** The storage key prefix: a sibling store (`pending-agent-input.ts`)
     *  keeps its own records under its own. */
    prefix?: string;
  } = {},
): PendingLaunchStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PENDING_LAUNCH_TTL_MS;
  const prefix = options.prefix ?? STORAGE_PREFIX;
  const claimQueues = new Map<string, Promise<unknown>>();
  const manifestKey = (sessionId: string) => manifestKeyIn(prefix, sessionId);
  const chunkKey = (sessionId: string, generation: string, index: number) =>
    chunkKeyIn(prefix, sessionId, generation, index);
  const parseManifest = (sessionId: string) => readManifest(storage, sessionId, manifestKey);

  async function deleteManifestChunks(
    storage: PendingLaunchStorage,
    sessionId: string,
    manifest: PendingManifest,
  ): Promise<void> {
    await storage.delete(manifestKey(sessionId));
    await Promise.all(
      Array.from({ length: manifest.chunks }, (_, index) =>
        storage.delete(chunkKey(sessionId, manifest.generation, index)),
      ),
    );
  }

  /** Whether a manifest was queued for the window as it ran on another host.
   *  One an earlier version saved names no host and is taken at its word. */
  function elsewhere(manifest: PendingManifest, hostId: string): boolean {
    return manifest.hostId !== undefined && manifest.hostId !== hostId;
  }

  function provisionalLapsed(manifest: PendingManifest): boolean {
    return (
      manifest.provisional === true && manifest.createdAt + PENDING_LAUNCH_PROVISIONAL_MS <= now()
    );
  }

  async function confirmPending(sessionId: string, hostId: string): Promise<void> {
    const manifest = await parseManifest(sessionId);
    if (manifest === null || manifest === "invalid" || manifest.provisional !== true) return;
    if (manifest.hostId !== hostId || manifest.delivered) return;
    const { provisional: _armed, ...confirmed } = manifest;
    await storage.set(manifestKey(sessionId), JSON.stringify(confirmed));
  }

  async function discardPending(sessionId: string, hostId: string): Promise<void> {
    const manifest = await parseManifest(sessionId);
    if (manifest === null || manifest === "invalid" || manifest.provisional !== true) return;
    if (manifest.hostId !== hostId) return;
    await deleteManifestChunks(storage, sessionId, manifest);
  }

  async function takePending(sessionId: string, hostId: string): Promise<PendingLaunchRead> {
    const manifest = await parseManifest(sessionId);
    if (manifest === null) return { status: "missing" };
    if (manifest === "invalid") {
      await storage.delete(manifestKey(sessionId));
      return { status: "lost", reason: "invalid_manifest" };
    }
    if (manifest.delivered) {
      await Promise.allSettled([
        storage.delete(manifestKey(sessionId)),
        ...Array.from({ length: manifest.chunks }, (_, index) =>
          storage.delete(chunkKey(sessionId, manifest.generation, index)),
        ),
      ]);
      return { status: "already_delivered" };
    }
    if (elsewhere(manifest, hostId)) {
      await deleteManifestChunks(storage, sessionId, manifest);
      return { status: "elsewhere" };
    }
    if (manifest.expiresAt <= now() || provisionalLapsed(manifest)) {
      await deleteManifestChunks(storage, sessionId, manifest);
      return { status: "stale" };
    }
    // Not yet: the server has not said this incarnation exists.
    if (manifest.provisional === true) return { status: "provisional" };
    const chunks = await Promise.all(
      Array.from({ length: manifest.chunks }, (_, index) =>
        storage.get(chunkKey(sessionId, manifest.generation, index)),
      ),
    );
    if (chunks.some((chunk) => chunk === null)) {
      await deleteManifestChunks(storage, sessionId, manifest);
      return { status: "lost", reason: "missing_chunk" };
    }

    // The flag is written before bytes leave JS. A crash can lose a launch, but cannot replay it.
    await storage.set(manifestKey(sessionId), JSON.stringify({ ...manifest, delivered: true }));
    return {
      status: "ready",
      record: {
        sessionId,
        hostId: manifest.hostId ?? null,
        command: chunks.join(""),
        createdAt: manifest.createdAt,
        expiresAt: manifest.expiresAt,
      },
    };
  }

  async function observePending(sessionId: string, hostId: string): Promise<void> {
    const manifest = await parseManifest(sessionId);
    if (manifest === null || manifest === "invalid" || manifest.delivered) return;
    if (elsewhere(manifest, hostId)) await deleteManifestChunks(storage, sessionId, manifest);
  }

  /** Claims and drops for one session run one at a time, in order. */
  async function serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = claimQueues.get(sessionId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(work);
    claimQueues.set(sessionId, queued);
    try {
      return await queued;
    } finally {
      if (claimQueues.get(sessionId) === queued) claimQueues.delete(sessionId);
    }
  }

  return {
    async persist(sessionId, hostId, command, options = {}) {
      const previous = await parseManifest(sessionId);
      const createdAt = now();
      const generation = `${createdAt.toString(36)}-${command.length.toString(36)}`;
      const chunks = chunkCommand(command);
      const manifest: PendingManifest = {
        version: 1,
        sessionId,
        createdAt,
        expiresAt: createdAt + ttlMs,
        hostId,
        generation,
        chunks: chunks.length,
        delivered: false,
        ...(options.provisional ? { provisional: true } : {}),
      };

      try {
        await Promise.all(
          chunks.map((chunk, index) => storage.set(chunkKey(sessionId, generation, index), chunk)),
        );
        await storage.set(manifestKey(sessionId), JSON.stringify(manifest));
      } catch (error) {
        await Promise.allSettled(
          chunks.map((_, index) => storage.delete(chunkKey(sessionId, generation, index))),
        );
        throw error;
      }

      if (previous !== null && previous !== "invalid" && previous.generation !== generation) {
        await Promise.allSettled(
          Array.from({ length: previous.chunks }, (_, index) =>
            storage.delete(chunkKey(sessionId, previous.generation, index)),
          ),
        );
      }
      return { sessionId, hostId, command, createdAt, expiresAt: manifest.expiresAt };
    },

    take: (sessionId, hostId) => serialized(sessionId, () => takePending(sessionId, hostId)),

    observe: (sessionId, hostId) => serialized(sessionId, () => observePending(sessionId, hostId)),

    confirm: (sessionId, hostId) => serialized(sessionId, () => confirmPending(sessionId, hostId)),

    discard: (sessionId, hostId) => serialized(sessionId, () => discardPending(sessionId, hostId)),

    async complete(sessionId) {
      const manifest = await parseManifest(sessionId);
      if (manifest === null) return;
      if (manifest === "invalid") {
        await storage.delete(manifestKey(sessionId));
        return;
      }
      await deleteManifestChunks(storage, sessionId, manifest);
    },

    async abandon(sessionId) {
      const manifest = await parseManifest(sessionId);
      if (manifest === null) return;
      if (manifest === "invalid") {
        await storage.delete(manifestKey(sessionId));
        return;
      }
      if (!manifest.delivered) {
        await storage.set(manifestKey(sessionId), JSON.stringify({ ...manifest, delivered: true }));
      }
      await deleteManifestChunks(storage, sessionId, manifest);
    },

    async clear(sessionId) {
      const manifest = await parseManifest(sessionId);
      if (manifest === null) return;
      if (manifest === "invalid") {
        await storage.delete(manifestKey(sessionId));
        return;
      }
      await deleteManifestChunks(storage, sessionId, manifest);
    },
  };
}

export const pendingLaunches = createPendingLaunchStore(secureStorage);
