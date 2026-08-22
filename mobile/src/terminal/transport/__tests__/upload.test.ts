import type { UploadRequest } from "@/terminal/transport/types";
import {
  canStartUpload,
  createUploadLifecycle,
  markFinalDispatched,
  reduceUploadBar,
  SESSION_UPLOAD_CHUNK_BYTES,
  SESSION_UPLOAD_MAX_BYTES,
  splitUploadBytes,
  updateUploadLifecycle,
  uploadChunkCount,
  uploadRatio,
  validUploadRequest,
} from "@/terminal/transport/upload";

function uploadRequest(
  overrides: Partial<UploadRequest> = {},
): UploadRequest & { uploadId: string } {
  const request: UploadRequest & { uploadId: string } = {
    uploadId: "00112233-4455-6677-8899-aabbccddeeff",
    name: "diagram.png",
    mimeType: "image/png",
    destination: "attachments",
    totalBytes: 1,
    sha256: "a".repeat(64),
    source: { size: 1, read: async () => new Uint8Array([1]) },
    beforeFinalDispatch: async () => undefined,
  };
  return { ...request, ...overrides };
}

describe("uploadRatio", () => {
  test("is null when nothing is in flight", () => {
    expect(uploadRatio([])).toBeNull();
  });

  test("reports one upload's byte progress", () => {
    expect(uploadRatio([{ sent: 250, total: 1000 }])).toBe(0.25);
  });

  test("weights concurrent uploads by size", () => {
    const ratio = uploadRatio([
      { sent: 40_000, total: 40_000 },
      { sent: 0, total: 20_000_000 },
    ]);
    expect(ratio).not.toBeNull();
    expect(ratio ?? 1).toBeLessThan(0.01);
  });

  test("shows an empty bar for zero-byte progress rather than dividing by zero", () => {
    expect(uploadRatio([{ sent: 0, total: 0 }])).toBe(0);
  });

  test("clamps negative and overshooting progress", () => {
    expect(uploadRatio([{ sent: 2000, total: 1000 }])).toBe(1);
    expect(uploadRatio([{ sent: -1, total: -1 }])).toBe(0);
  });
});

describe("upload progress bar state", () => {
  test("paints at least four percent, holds 420 ms, and fades for 200 ms", () => {
    let state = reduceUploadBar({ phase: "hidden" }, { type: "ratio", ratio: 0, now: 100 });
    expect(state).toEqual({ phase: "active", ratio: 0.04, shownAt: 100 });
    state = reduceUploadBar(state, { type: "ratio", ratio: null, now: 200 });
    expect(state).toEqual({ phase: "holding", shownAt: 100, fadeAt: 520 });
    state = reduceUploadBar(state, { type: "tick", now: 519 });
    expect(state.phase).toBe("holding");
    state = reduceUploadBar(state, { type: "tick", now: 520 });
    expect(state).toEqual({ phase: "fading", fadeEndsAt: 720 });
    state = reduceUploadBar(state, { type: "tick", now: 719 });
    expect(state.phase).toBe("fading");
    state = reduceUploadBar(state, { type: "tick", now: 720 });
    expect(state.phase).toBe("hidden");
  });

  test("a new upload cancels hold or fade", () => {
    const state = reduceUploadBar(
      { phase: "fading", fadeEndsAt: 1000 },
      { type: "ratio", ratio: 0.5, now: 900 },
    );
    expect(state).toEqual({ phase: "active", ratio: 0.5, shownAt: 900 });
  });
});

describe("session upload lifecycle", () => {
  test("validates the strict upload manifest before dispatch", () => {
    expect(validUploadRequest(uploadRequest())).toBe(true);
    expect(validUploadRequest(uploadRequest({ name: "../secret" }))).toBe(false);
    expect(validUploadRequest(uploadRequest({ name: "bad\u0085name" }))).toBe(false);
    expect(validUploadRequest(uploadRequest({ mimeType: "image/png; charset=utf-8" }))).toBe(false);
    expect(
      validUploadRequest(uploadRequest({ mimeType: "text/plain", destination: "attachments" })),
    ).toBe(false);
    expect(validUploadRequest(uploadRequest({ destination: "cwd", mimeType: "text/plain" }))).toBe(
      true,
    );
  });

  test("uses 48 KiB chunks and enforces the 20 MiB ceiling", () => {
    expect(uploadChunkCount(SESSION_UPLOAD_CHUNK_BYTES * 2 + 1)).toBe(3);
    expect(uploadChunkCount(SESSION_UPLOAD_MAX_BYTES)).toBe(
      Math.ceil(SESSION_UPLOAD_MAX_BYTES / SESSION_UPLOAD_CHUNK_BYTES),
    );
    expect(uploadChunkCount(0)).toBeNull();
    expect(uploadChunkCount(SESSION_UPLOAD_MAX_BYTES + 1)).toBeNull();
    expect(
      splitUploadBytes(new Uint8Array(SESSION_UPLOAD_CHUNK_BYTES + 1))?.map(
        (chunk) => chunk.byteLength,
      ),
    ).toEqual([SESSION_UPLOAD_CHUNK_BYTES, 1]);
  });

  test("allows at most four active uploads", () => {
    expect([0, 1, 2, 3].every(canStartUpload)).toBe(true);
    expect(canStartUpload(4)).toBe(false);
  });

  test("keeps a stable UUID through resume and outcome_unknown", () => {
    const uploadId = "00112233-4455-6677-8899-aabbccddeeff";
    let state = createUploadLifecycle(uploadId, 100);
    state = updateUploadLifecycle(state, {
      uploadId,
      state: "uploading",
      sentBytes: 48,
      totalBytes: 100,
    });
    expect(state).toMatchObject({ uploadId, sentBytes: 48, state: "uploading" });
    state = markFinalDispatched(state);
    expect(state).toMatchObject({ uploadId, state: "outcome_unknown", finalDispatched: true });
    state = updateUploadLifecycle(state, {
      uploadId,
      state: "complete",
      sentBytes: 100,
      totalBytes: 100,
      path: "/tmp/file",
    });
    expect(state).toMatchObject({
      uploadId,
      state: "complete",
      finalDispatched: true,
      path: "/tmp/file",
    });
  });
});
