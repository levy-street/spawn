import { act, renderHook, waitFor } from "@testing-library/react-native";

import { pickImages } from "@/components/media/image-source";
import { useTerminalTransfers } from "@/components/terminal-ui/use-terminal-transfers";
import type {
  SessionTransport,
  UploadHandle,
  UploadRequest,
  UploadResult,
} from "@/terminal/transport/types";
import { duration } from "@/theme";

jest.mock("@/components/media/image-source", () => ({
  pickImages: jest.fn(),
}));

jest.mock("@/components/terminal-ui/upload-file", () => ({
  clearUploadOutcome: jest.fn(async () => undefined),
  prepareTerminalUpload: jest.fn(
    async (asset: { name: string }, destination: "attachments" | "cwd") => ({
      uploadId: `upload-${asset.name}`,
      name: asset.name,
      mimeType: "image/jpeg",
      destination,
      totalBytes: 4,
      sha256: "0".repeat(64),
      source: { size: 4, read: async () => new Uint8Array(4) },
    }),
  ),
}));

const mockPickImages = pickImages as jest.MockedFunction<typeof pickImages>;

interface FakeTransport {
  transport: SessionTransport;
  written: string[];
  uploaded: string[];
}

function fakeTransport(failOn: readonly string[] = []): FakeTransport {
  const written: string[] = [];
  const uploaded: string[] = [];
  const decoder = new TextDecoder();
  const transport = {
    write: (bytes: Uint8Array) => written.push(decoder.decode(bytes)),
    upload: (request: UploadRequest & { uploadId?: string }): UploadHandle => {
      const uploadId = request.uploadId ?? request.name;
      uploaded.push(request.name);
      const result: Promise<UploadResult> = failOn.includes(request.name)
        ? Promise.reject(new Error("The host refused the file."))
        : Promise.resolve({
            uploadId,
            path: `/work/${request.name}`,
            totalBytes: request.totalBytes,
            sha256: request.sha256,
          });
      return {
        uploadId,
        state: "uploading",
        result,
        cancel: () => undefined,
        onProgress: () => () => undefined,
      };
    },
  } as unknown as SessionTransport;
  return { transport, written, uploaded };
}

function renderTransfers(transport: SessionTransport, onFocusTerminal = jest.fn()) {
  return renderHook(() =>
    useTerminalTransfers({
      transport: () => transport,
      ready: true,
      onInputSent: jest.fn(),
      onFocusTerminal,
    }),
  );
}

describe("attaching several files in one visit to the picker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("every picked photo is uploaded and pasted at the prompt", async () => {
    mockPickImages.mockResolvedValue([
      { uri: "file:///one.jpg", name: "one.jpg", mimeType: "image/jpeg" },
      { uri: "file:///two.jpg", name: "two.jpg", mimeType: "image/jpeg" },
    ]);
    const { transport, written, uploaded } = fakeTransport();
    const onFocusTerminal = jest.fn();
    const view = await renderTransfers(transport, onFocusTerminal);

    await act(async () => {
      await view.result.current.attach("photos");
    });

    expect(mockPickImages).toHaveBeenCalledWith("photos", { fileTypes: "*/*", multiple: true });
    expect(uploaded).toEqual(["one.jpg", "two.jpg"]);
    expect(written.join("")).toContain("/work/one.jpg");
    expect(written.join("")).toContain("/work/two.jpg");
    // The paths are at the prompt where they can be read; nothing hangs over
    // the output saying so.
    expect(view.result.current.notice).toBeNull();
    expect(onFocusTerminal).toHaveBeenCalledTimes(1);
  });

  test("a file that fails is named, and the rest of the queue still lands", async () => {
    mockPickImages.mockResolvedValue([
      { uri: "file:///good.txt", name: "good.txt", mimeType: "text/plain" },
      { uri: "file:///bad.txt", name: "bad.txt", mimeType: "text/plain" },
    ]);
    const { transport, uploaded } = fakeTransport(["bad.txt"]);
    const view = await renderTransfers(transport);

    await act(async () => {
      await view.result.current.attach("files");
    });

    expect(uploaded).toEqual(["good.txt", "bad.txt"]);
    expect(view.result.current.notice).toBe("bad.txt: The host refused the file.");
  });

  test("files saved out of sight are counted, since their paths are not shown", async () => {
    mockPickImages.mockResolvedValue([
      { uri: "file:///a.txt", name: "a.txt", mimeType: "text/plain" },
      { uri: "file:///b.txt", name: "b.txt", mimeType: "text/plain" },
    ]);
    const view = await renderTransfers(fakeTransport().transport);

    await act(async () => {
      await view.result.current.attach("files");
    });

    expect(view.result.current.notice).toBe("Uploaded 2 files.");
  });

  test("backing out of the picker uploads nothing", async () => {
    mockPickImages.mockResolvedValue([]);
    const { transport, uploaded } = fakeTransport();
    const view = await renderTransfers(transport);

    await act(async () => {
      await view.result.current.attach("photos");
    });

    expect(uploaded).toEqual([]);
    expect(view.result.current.notice).toBeNull();
  });
});

describe("a notice retires itself", () => {
  test("the message clears once it has had time to be read", async () => {
    jest.useFakeTimers();
    try {
      const view = await renderTransfers(fakeTransport().transport);

      await act(async () => {
        view.result.current.setNotice("Session restarted.");
      });
      expect(view.result.current.notice).toBe("Session restarted.");

      await act(async () => {
        jest.advanceTimersByTime(duration.toastInfo);
      });
      await waitFor(() => expect(view.result.current.notice).toBeNull());
    } finally {
      jest.useRealTimers();
    }
  });
});
