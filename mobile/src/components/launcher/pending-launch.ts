import { secureStorage } from "@/lib/secure-storage";

const STORAGE_PREFIX = "spawn.pendingLaunch";
const CHUNK_BYTES = 1_536;
export const PENDING_LAUNCH_TTL_MS = 15 * 60 * 1_000;

export interface PendingLaunchRecord {
  sessionId: string;
  command: string;
  createdAt: number;
  expiresAt: number;
}

interface PendingManifest extends Omit<PendingLaunchRecord, "command"> {
  version: 1;
  generation: string;
  chunks: number;
}

export interface PendingLaunchStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type PendingLaunchRead =
  | { status: "ready"; record: PendingLaunchRecord }
  | { status: "missing" }
  | { status: "stale" }
  | { status: "lost"; reason: string };

export interface PendingLaunchStore {
  persist(sessionId: string, command: string): Promise<PendingLaunchRecord>;
  take(sessionId: string): Promise<PendingLaunchRead>;
  clear(sessionId: string): Promise<void>;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function manifestKey(sessionId: string): string {
  return `${STORAGE_PREFIX}.${safeSessionId(sessionId)}`;
}

function chunkKey(sessionId: string, generation: string, index: number): string {
  return `${manifestKey(sessionId)}.${generation}.${index}`;
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
    typeof candidate["generation"] === "string" &&
    Number.isInteger(candidate["chunks"]) &&
    Number(candidate["chunks"]) > 0
  );
}

async function parseManifest(
  storage: PendingLaunchStorage,
  sessionId: string,
): Promise<PendingManifest | null | "invalid"> {
  const raw = await storage.get(manifestKey(sessionId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isManifest(parsed) && parsed.sessionId === sessionId ? parsed : "invalid";
  } catch {
    return "invalid";
  }
}

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

export function createPendingLaunchStore(
  storage: PendingLaunchStorage,
  options: { now?: () => number; ttlMs?: number } = {},
): PendingLaunchStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PENDING_LAUNCH_TTL_MS;

  return {
    async persist(sessionId, command) {
      const previous = await parseManifest(storage, sessionId);
      const createdAt = now();
      const generation = `${createdAt.toString(36)}-${command.length.toString(36)}`;
      const chunks = chunkCommand(command);
      const manifest: PendingManifest = {
        version: 1,
        sessionId,
        createdAt,
        expiresAt: createdAt + ttlMs,
        generation,
        chunks: chunks.length,
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
      return { sessionId, command, createdAt, expiresAt: manifest.expiresAt };
    },

    async take(sessionId) {
      const manifest = await parseManifest(storage, sessionId);
      if (manifest === null) return { status: "missing" };
      if (manifest === "invalid") {
        await storage.delete(manifestKey(sessionId));
        return { status: "lost", reason: "The saved launch command could not be read." };
      }
      if (manifest.expiresAt <= now()) {
        await deleteManifestChunks(storage, sessionId, manifest);
        return { status: "stale" };
      }
      const chunks = await Promise.all(
        Array.from({ length: manifest.chunks }, (_, index) =>
          storage.get(chunkKey(sessionId, manifest.generation, index)),
        ),
      );
      if (chunks.some((chunk) => chunk === null)) {
        await deleteManifestChunks(storage, sessionId, manifest);
        return { status: "lost", reason: "Part of the saved launch command is missing." };
      }
      await deleteManifestChunks(storage, sessionId, manifest);
      return {
        status: "ready",
        record: {
          sessionId,
          command: chunks.join(""),
          createdAt: manifest.createdAt,
          expiresAt: manifest.expiresAt,
        },
      };
    },

    async clear(sessionId) {
      const manifest = await parseManifest(storage, sessionId);
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
