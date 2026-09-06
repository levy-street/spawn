import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

/** The session worker is one IIFE inside the bundled asset; run just that. */
export function sessionWorkerSource(): string {
  const marker = "const MAX_PREBOOT_BYTES = 12 * 1024 * 1024";
  const markerIndex = TERMINAL_WORKER_HTML.indexOf(marker);
  const start = TERMINAL_WORKER_HTML.lastIndexOf("(() => {", markerIndex);
  const end = TERMINAL_WORKER_HTML.indexOf("\n})();", markerIndex) + "\n})();".length;
  if (markerIndex < 0 || start < 0 || end < start) {
    throw new Error("Session worker source is missing.");
  }
  return TERMINAL_WORKER_HTML.slice(start, end);
}

/** Run the worker against `instance` as its `globalThis.spawnWorker`. */
export async function runWorker<T>(instance: T, body: (worker: T) => Promise<void>) {
  const root = globalThis as unknown as { spawnWorker?: T };
  const previous = root.spawnWorker;
  root.spawnWorker = instance;
  try {
    new Function(sessionWorkerSource())();
    await body(instance);
  } finally {
    if (previous) root.spawnWorker = previous;
    else delete root.spawnWorker;
  }
}

/** One SPCT replay chunk, framed as the daemon frames it. */
export function spctFrame(requestId: string, sequence: number, last: boolean, payload: Uint8Array) {
  const frame = new Uint8Array(28 + payload.byteLength);
  frame.set([0x53, 0x50, 0x43, 0x54, 1, 1]);
  const view = new DataView(frame.buffer);
  view.setUint16(6, last ? 1 : 0, true);
  const hex = requestId.replaceAll("-", "");
  for (let index = 0; index < 16; index += 1) {
    frame[8 + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  view.setUint32(24, sequence, true);
  frame.set(payload, 28);
  return frame;
}

/** The worker chains control messages on a promise tail; a few macrotask
 *  turns let a replay of any chunk count drain through it. */
export async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
