const mockFiles = new Map<string, Uint8Array>();
const mockReads: { offset: number; length: number }[] = [];
const mockDeleted: string[] = [];

jest.mock("expo-file-system", () => {
  class File {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get size() {
      return mockFiles.get(this.uri)?.byteLength ?? 0;
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    delete() {
      mockDeleted.push(this.uri);
      mockFiles.delete(this.uri);
    }
    open() {
      const bytes = mockFiles.get(this.uri) ?? new Uint8Array(0);
      return {
        offset: 0 as number | null,
        size: bytes.byteLength,
        readBytes(length: number) {
          const start = this.offset ?? 0;
          mockReads.push({ offset: start, length });
          const out = bytes.slice(start, start + length);
          this.offset = start + out.byteLength;
          return out;
        },
        writeBytes() {},
        close() {},
      };
    }
  }
  return { File, Paths: { cache: { uri: "file:///app/cache/" } } };
});

import { openLocalFileSource, releaseLocalCopy } from "@/components/files/upload-source";

beforeEach(() => {
  mockFiles.clear();
  mockReads.length = 0;
  mockDeleted.length = 0;
});

describe("a picked file as an upload source", () => {
  test("is read a buffer at a time, from the start again for the second pass", async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    mockFiles.set("file:///app/cache/a.bin", bytes);
    const source = openLocalFileSource("file:///app/cache/a.bin", 32);
    expect(source.size).toBe(100);
    const first: number[] = [];
    for (let offset = 0; offset < 100; offset += 8) {
      first.push(...(await source.read(offset, Math.min(8, 100 - offset))));
    }
    expect(first).toEqual([...bytes]);
    // Four buffers of 32 cover the hundred bytes.
    expect(mockReads.map((read) => read.offset)).toEqual([0, 32, 64, 96]);
    mockReads.length = 0;
    expect([...(await source.read(0, 8))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(mockReads).toEqual([{ offset: 0, length: 32 }]);
    source.close();
    await expect(source.read(0, 8)).rejects.toThrow("closed");
  });

  test("hands back a short read short, for the transport to refuse", async () => {
    mockFiles.set("file:///app/cache/b.bin", new Uint8Array(10));
    const source = openLocalFileSource("file:///app/cache/b.bin", 4);
    expect((await source.read(8, 4)).byteLength).toBe(2);
  });

  test("only the picker's copies in the app's cache are ever deleted", () => {
    mockFiles.set("file:///app/cache/c.bin", new Uint8Array(1));
    mockFiles.set("file:///Users/me/Photos/d.jpg", new Uint8Array(1));
    releaseLocalCopy("file:///app/cache/c.bin");
    releaseLocalCopy("file:///Users/me/Photos/d.jpg");
    releaseLocalCopy("file:///app/cache/../../Users/me/Photos/d.jpg");
    expect(mockDeleted).toEqual(["file:///app/cache/c.bin"]);
  });
});
