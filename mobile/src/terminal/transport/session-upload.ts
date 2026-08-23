import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid } from "@/lib/crypto/bytes";
import {
  encodeBridgeBytes,
  TERMINAL_BRIDGE_VERSION,
  type WorkerToNativeMessage,
} from "@/terminal/transport/bridge";
import type {
  TransportError,
  UploadHandle,
  UploadProgress,
  UploadRequest,
  UploadResult,
  UploadState,
  WorkerEndpoint,
} from "@/terminal/transport/types";
import {
  canStartUpload,
  SESSION_UPLOAD_CHUNK_BYTES,
  validUploadRequest,
} from "@/terminal/transport/upload";

function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

class SessionUploadHandle implements UploadHandle {
  currentState: UploadState = "queued";
  sentBytes = 0;
  readonly listeners = new Set<(progress: UploadProgress) => void>();
  readonly result: Promise<UploadResult>;
  resolveResult!: (result: UploadResult) => void;
  rejectResult!: (error: Error) => void;
  pumping = false;
  cancelled = false;
  finalDispatched = false;
  finalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly uploadId: string,
    readonly request: UploadRequest,
    private readonly cancelUpload: (uploadId: string) => void,
  ) {
    this.result = new Promise<UploadResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  get state(): UploadState {
    return this.currentState;
  }

  cancel(): void {
    if (this.cancelled || this.currentState === "complete") return;
    this.cancelled = true;
    this.cancelUpload(this.uploadId);
  }

  onProgress(listener: (progress: UploadProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(progress: UploadProgress): void {
    this.currentState = progress.state;
    this.sentBytes = progress.sentBytes;
    for (const listener of this.listeners) listener(progress);
  }
}

export class SessionUploadCoordinator {
  readonly #uploads = new Map<string, SessionUploadHandle>();

  constructor(private readonly bridge: WorkerEndpoint) {}

  create(request: UploadRequest, ready: boolean): UploadHandle {
    const uploadId = request.uploadId ?? newUuid();
    const active = Array.from(this.#uploads.values()).filter((upload) =>
      ["queued", "starting", "uploading", "outcome_unknown"].includes(upload.state),
    ).length;
    const handle = new SessionUploadHandle(uploadId, request, (id) => this.#cancel(id));
    if (!validUploadRequest({ ...request, uploadId }) || !canStartUpload(active)) {
      queueMicrotask(() =>
        this.#reject(
          handle,
          "invalid_upload",
          "Session upload metadata is invalid or the four-upload limit is reached.",
          false,
        ),
      );
      return handle;
    }
    this.#uploads.set(uploadId, handle);
    if (ready) this.#start(handle);
    return handle;
  }

  startPending(): void {
    for (const upload of this.#uploads.values()) {
      if (!upload.finalDispatched && upload.state !== "complete") this.#start(upload, true);
    }
  }

  close(): void {
    for (const upload of this.#uploads.values()) {
      if (upload.finalDispatched)
        this.#markOutcomeUnknown(upload, "Connection closed after final dispatch.");
      else
        this.#reject(upload, "upload_closed", "Connection closed before upload completion.", true);
    }
  }

  handleProgress(message: Extract<WorkerToNativeMessage, { type: "upload-progress" }>): void {
    const upload = this.#uploads.get(message.uploadId);
    if (!upload) return;
    upload.emit({
      uploadId: upload.uploadId,
      state: message.state,
      sentBytes: message.sentBytes,
      totalBytes: message.totalBytes,
      ...(message.path === undefined ? {} : { path: message.path }),
      ...(message.error === undefined ? {} : { error: message.error }),
    });
    if (message.state === "uploading" && message.nextSequence !== undefined) {
      void this.#pump(upload, message.nextSequence);
    } else if (message.state === "outcome_unknown") {
      upload.finalDispatched = true;
      upload.finalTimer ??= setTimeout(
        () =>
          this.#markOutcomeUnknown(upload, "Upload completion acknowledgement was not received."),
        30_000,
      );
    } else if (message.state === "complete" && message.path && message.sha256) {
      if (upload.finalTimer) clearTimeout(upload.finalTimer);
      upload.resolveResult({
        uploadId: upload.uploadId,
        path: message.path,
        totalBytes: upload.request.totalBytes,
        sha256: message.sha256,
      });
      this.#uploads.delete(upload.uploadId);
    } else if (message.state === "failed" || message.state === "cancelled") {
      this.#reject(
        upload,
        message.error?.code ?? message.state,
        message.error?.message ?? "Upload did not complete.",
        message.error?.retryable ?? false,
      );
    }
  }

  #start(upload: SessionUploadHandle, force = false): void {
    if (upload.cancelled || upload.finalDispatched || (!force && upload.state === "starting"))
      return;
    upload.emit({
      uploadId: upload.uploadId,
      state: "starting",
      sentBytes: upload.sentBytes,
      totalBytes: upload.request.totalBytes,
    });
    this.bridge.send({
      v: TERMINAL_BRIDGE_VERSION,
      type: "upload-start",
      uploadId: upload.uploadId,
      name: upload.request.name,
      mimeType: upload.request.mimeType,
      destination: upload.request.destination,
      totalBytes: upload.request.totalBytes,
      sha256: upload.request.sha256,
    });
  }

  async #pump(upload: SessionUploadHandle, sequence: number): Promise<void> {
    if (upload.pumping || upload.cancelled || upload.finalDispatched) return;
    upload.pumping = true;
    try {
      const offset = sequence * SESSION_UPLOAD_CHUNK_BYTES;
      const length = Math.min(SESSION_UPLOAD_CHUNK_BYTES, upload.request.totalBytes - offset);
      const last = offset + length === upload.request.totalBytes;
      const bytes = await upload.request.source.read(offset, length);
      if (bytes.byteLength !== length)
        throw new Error("Upload source returned an unexpected chunk length.");
      if (last) {
        await upload.request.beforeFinalDispatch();
        upload.finalDispatched = true;
      }
      this.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "upload-chunk",
        uploadId: upload.uploadId,
        sequence,
        last,
        data: encodeBridgeBytes(bytes),
      });
    } catch (error) {
      if (upload.finalDispatched)
        this.#markOutcomeUnknown(
          upload,
          error instanceof Error ? error.message : "Final upload outcome is unknown.",
        );
      else
        this.#reject(
          upload,
          "upload_source",
          error instanceof Error ? error.message : "Upload source failed.",
          false,
        );
    } finally {
      upload.pumping = false;
    }
  }

  #cancel(uploadId: string): void {
    const upload = this.#uploads.get(uploadId);
    if (!upload || upload.finalDispatched) return;
    this.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "upload-cancel", uploadId });
    this.#reject(upload, "cancelled", "Upload cancelled.", false, "cancelled");
  }

  #reject(
    upload: SessionUploadHandle,
    code: string,
    message: string,
    retryable: boolean,
    state: UploadState = "failed",
  ): void {
    const error = { code, message, retryable } satisfies TransportError;
    upload.emit({
      uploadId: upload.uploadId,
      state,
      sentBytes: upload.sentBytes,
      totalBytes: upload.request.totalBytes,
      error,
    });
    upload.rejectResult(new Error(message));
    this.#uploads.delete(upload.uploadId);
  }

  #markOutcomeUnknown(upload: SessionUploadHandle, message: string): void {
    if (upload.finalTimer) clearTimeout(upload.finalTimer);
    const error = { code: "outcome_unknown", message, retryable: false } satisfies TransportError;
    upload.emit({
      uploadId: upload.uploadId,
      state: "outcome_unknown",
      sentBytes: upload.sentBytes,
      totalBytes: upload.request.totalBytes,
      error,
    });
    upload.rejectResult(new Error(message));
    this.#uploads.delete(upload.uploadId);
  }
}
