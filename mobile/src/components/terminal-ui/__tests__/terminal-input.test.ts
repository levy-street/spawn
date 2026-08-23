import {
  chunkTerminalInput,
  TERMINAL_INPUT_CHUNK_BYTES,
  writeTerminalInput,
} from "@/components/terminal-ui/terminal-input";
import type { SessionTransport } from "@/terminal/transport/types";

describe("terminal input chunking", () => {
  test("never creates a frame larger than 64 KiB", () => {
    const bytes = new Uint8Array(TERMINAL_INPUT_CHUNK_BYTES * 2 + 7);
    const chunks = chunkTerminalInput(bytes);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      TERMINAL_INPUT_CHUNK_BYTES,
      TERMINAL_INPUT_CHUNK_BYTES,
      7,
    ]);
  });

  test("writes every chunk in order and reports completion", async () => {
    const writes: Uint8Array[] = [];
    const transport = {
      write: (chunk: Uint8Array) => {
        writes.push(chunk);
      },
    } as unknown as SessionTransport;
    const progress: number[] = [];
    const originalFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;

    try {
      const bytes = new Uint8Array(TERMINAL_INPUT_CHUNK_BYTES + 1).map((_, index) => index % 255);
      await writeTerminalInput(transport, bytes, (ratio) => progress.push(ratio));
      expect(writes.map((chunk) => chunk.byteLength)).toEqual([TERMINAL_INPUT_CHUNK_BYTES, 1]);
      const reconstructed = new Uint8Array(bytes.byteLength);
      let offset = 0;
      for (const chunk of writes) {
        reconstructed.set(chunk, offset);
        offset += chunk.byteLength;
      }
      expect(reconstructed).toEqual(bytes);
      expect(progress.at(-1)).toBe(1);
    } finally {
      globalThis.requestAnimationFrame = originalFrame;
    }
  });
});
