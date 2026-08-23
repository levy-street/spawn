import type { UploadProgress, UploadRequest, UploadState } from "@/terminal/transport/types";

export const SESSION_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const SESSION_UPLOAD_CHUNK_BYTES = 48 * 1024;
export const SESSION_UPLOAD_MAX_ACTIVE = 4;
export const UPLOAD_PROGRESS_MIN_VISIBLE_MS = 420;
export const UPLOAD_PROGRESS_FADE_MS = 200;
export const UPLOAD_PROGRESS_MIN_RATIO = 0.04;

export interface UploadTrack {
  sent: number;
  total: number;
}

export type UploadBarState =
  | { phase: "hidden" }
  | { phase: "active"; ratio: number; shownAt: number }
  | { phase: "holding"; shownAt: number; fadeAt: number }
  | { phase: "fading"; fadeEndsAt: number };

export type UploadBarEvent =
  | { type: "ratio"; ratio: number | null; now: number }
  | { type: "tick"; now: number };

export interface UploadLifecycle {
  uploadId: string;
  state: UploadState;
  sentBytes: number;
  totalBytes: number;
  finalDispatched: boolean;
  path?: string;
}

export function uploadRatio(tracks: readonly UploadTrack[]): number | null {
  if (tracks.length === 0) return null;
  let total = 0;
  let sent = 0;
  for (const track of tracks) {
    const size = Math.max(0, track.total);
    total += size;
    sent += Math.min(Math.max(0, track.sent), size);
  }
  return total === 0 ? 0 : Math.min(1, sent / total);
}

export function paintedUploadRatio(ratio: number): number {
  return Math.min(1, Math.max(UPLOAD_PROGRESS_MIN_RATIO, ratio));
}

export function reduceUploadBar(state: UploadBarState, event: UploadBarEvent): UploadBarState {
  if (event.type === "ratio") {
    if (event.ratio !== null) {
      const shownAt =
        state.phase === "hidden" ? event.now : "shownAt" in state ? state.shownAt : event.now;
      return { phase: "active", ratio: paintedUploadRatio(event.ratio), shownAt };
    }
    if (state.phase !== "active") return state;
    return {
      phase: "holding",
      shownAt: state.shownAt,
      fadeAt: Math.max(event.now, state.shownAt + UPLOAD_PROGRESS_MIN_VISIBLE_MS),
    };
  }

  if (state.phase === "holding" && event.now >= state.fadeAt) {
    return { phase: "fading", fadeEndsAt: event.now + UPLOAD_PROGRESS_FADE_MS };
  }
  if (state.phase === "fading" && event.now >= state.fadeEndsAt) return { phase: "hidden" };
  return state;
}

export function createUploadLifecycle(uploadId: string, totalBytes: number): UploadLifecycle {
  return { uploadId, state: "queued", sentBytes: 0, totalBytes, finalDispatched: false };
}

export function updateUploadLifecycle(
  lifecycle: UploadLifecycle,
  progress: UploadProgress,
): UploadLifecycle {
  if (lifecycle.uploadId !== progress.uploadId) return lifecycle;
  const sentBytes = Math.min(lifecycle.totalBytes, Math.max(0, progress.sentBytes));
  return {
    ...lifecycle,
    state: progress.state,
    sentBytes,
    finalDispatched: lifecycle.finalDispatched || progress.state === "outcome_unknown",
    ...(progress.path === undefined ? {} : { path: progress.path }),
  };
}

export function markFinalDispatched(lifecycle: UploadLifecycle): UploadLifecycle {
  if (lifecycle.state === "complete" || lifecycle.state === "cancelled") return lifecycle;
  return { ...lifecycle, state: "outcome_unknown", finalDispatched: true };
}

export function uploadChunkCount(totalBytes: number): number | null {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    totalBytes > SESSION_UPLOAD_MAX_BYTES
  ) {
    return null;
  }
  return Math.ceil(totalBytes / SESSION_UPLOAD_CHUNK_BYTES);
}

export function splitUploadBytes(bytes: Uint8Array): Uint8Array[] | null {
  if (uploadChunkCount(bytes.byteLength) === null) return null;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SESSION_UPLOAD_CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, offset + SESSION_UPLOAD_CHUNK_BYTES));
  }
  return chunks;
}

export function canStartUpload(activeUploads: number): boolean {
  return (
    Number.isSafeInteger(activeUploads) &&
    activeUploads >= 0 &&
    activeUploads < SESSION_UPLOAD_MAX_ACTIVE
  );
}

function hasInvalidUploadNameCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "/" || character === "\\" || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export function validUploadRequest(request: UploadRequest & { uploadId: string }): boolean {
  const nameBytes = new TextEncoder().encode(request.name).byteLength;
  const mimeBytes = new TextEncoder().encode(request.mimeType).byteLength;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.uploadId) &&
    uploadChunkCount(request.totalBytes) !== null &&
    request.source.size === request.totalBytes &&
    nameBytes >= 1 &&
    nameBytes <= 255 &&
    request.name !== "." &&
    request.name !== ".." &&
    !hasInvalidUploadNameCharacter(request.name) &&
    mimeBytes >= 1 &&
    mimeBytes <= 128 &&
    /^[\x21-\x7e]+$/.test(request.mimeType) &&
    !request.mimeType.includes(";") &&
    (request.destination === "cwd" ||
      (request.destination === "attachments" &&
        (request.mimeType.startsWith("image/") || request.mimeType === "application/json"))) &&
    /^[0-9a-f]{64}$/.test(request.sha256)
  );
}
