import { describe, expect, test } from "bun:test";

import { hashStream, Sha256 } from "./sha256";

describe("incremental SHA-256", () => {
  test("matches standard vectors across chunk boundaries", () => {
    const hash = new Sha256();
    hash.update(new TextEncoder().encode("a"));
    hash.update(new TextEncoder().encode("bc"));
    expect(hash.digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("hashes a bounded stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    await expect(hashStream(stream)).resolves.toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});
