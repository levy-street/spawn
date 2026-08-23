import type { UploadRequest } from "@/terminal/transport/types";

import { FakeSessionTransport } from "../fake-transport";

function uploadRequest(): UploadRequest {
  return {
    name: "notes.txt",
    mimeType: "text/plain",
    destination: "cwd",
    totalBytes: 3,
    sha256: "abc123",
    source: {
      size: 3,
      read: async () => new Uint8Array([1, 2, 3]),
    },
    beforeFinalDispatch: async () => undefined,
  };
}

describe("FakeSessionTransport", () => {
  it("records calls and emits only to active subscribers", async () => {
    const transport = new FakeSessionTransport("session-test");
    const states: string[] = [];
    const titles: string[] = [];
    const stopTitles = transport.on("title", (title) => titles.push(title));
    transport.on("state", (state) => states.push(state));

    await transport.open();
    const bytes = new Uint8Array([1, 2, 3]);
    transport.write(bytes);
    bytes[0] = 9;
    transport.resize(120, 40);
    transport.requestReplay(24);
    transport.emitTitle("Build");
    stopTitles();
    transport.emitTitle("Ignored");
    transport.close();

    expect(states).toEqual(["ready", "closed"]);
    expect(titles).toEqual(["Build"]);
    expect(transport.writes[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(transport.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(transport.replayRequests).toEqual([24]);
  });

  it("provides controllable upload progress and completion", async () => {
    const transport = new FakeSessionTransport();
    const handle = transport.upload(uploadRequest());
    const states: string[] = [];
    handle.onProgress((progress) => states.push(progress.state));

    handle.progress({ state: "uploading", sentBytes: 2 });
    handle.complete("/tmp/notes.txt");

    expect(states).toEqual(["uploading", "complete"]);
    await expect(handle.result).resolves.toEqual({
      uploadId: "fake-upload-1",
      path: "/tmp/notes.txt",
      totalBytes: 3,
      sha256: "abc123",
    });
  });
});
