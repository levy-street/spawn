/**
 * Where a download's bytes go in this browser, chosen at the click.
 *
 * 1. **A save picker** (`showSaveFilePicker`, Chromium): asked at once, while
 *    the click still counts as a gesture; bytes stream straight into the file
 *    the person picked. Any size.
 * 2. **Memory**, for anything that fits in `MEMORY_DOWNLOAD_LIMIT`: held as a
 *    Blob and handed to the browser's own download when complete. This is
 *    what every browser did before streaming existed, and it stays the path
 *    for small files.
 * 3. **A streamed download through the service worker**, for anything bigger
 *    where there is no picker (Safari, Firefox): the page hands the bytes to
 *    `public/sw.js` over a private MessagePort, and the worker answers a
 *    one-time URL (`/__spawn/stream/<token>`) with them as an attachment.
 *    The route never touches the Cache API or the network, the URL carries
 *    nothing but the token (never a host path or file name), and a token is
 *    good for one fetch. When there is no worker in control of the page (the
 *    first visit, a hard reload, private browsing) or the worker in control
 *    is an older one without the route, the download falls back to memory
 *    and says plainly when that is not enough.
 */

import { browserStoppedSaving, downloadTooLargeNotice } from "./copy";
import { formatSize } from "./format";
import type { ByteSink, SinkOpener } from "./transfer-engine";

/** What a download held in memory may grow to. */
export const MEMORY_DOWNLOAD_LIMIT = 32 * 1024 * 1024;
export const STREAM_ROUTE = "/__spawn/stream/";

type SavePicker = (options: { suggestedName: string }) => Promise<{
  createWritable: () => Promise<{
    write: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    abort: (reason?: unknown) => Promise<void>;
  }>;
}>;

/**
 * Pick where a download goes. Call it from the click itself: a save picker is
 * refused once the gesture has passed. Null when the person cancelled the
 * picker.
 */
export async function chooseDownloadSink(suggestedName: string): Promise<SinkOpener | null> {
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({ suggestedName });
      return {
        limit: null,
        open: async () => {
          const writable = await handle.createWritable();
          return {
            write: (bytes) => writable.write(bytes),
            close: () => writable.close(),
            abort: (reason) => writable.abort(reason).catch(() => {}),
          };
        },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      // No gesture left, or not allowed here: save another way.
    }
  }
  return streamingOrMemory();
}

/** No picker: memory for what fits, the service worker for what doesn't. */
export function streamingOrMemory(
  worker: ServiceWorker | null = currentWorker(),
  limit = MEMORY_DOWNLOAD_LIMIT,
): SinkOpener {
  return {
    limit: worker ? null : limit,
    open: async (name, size) => {
      if (worker && (size === null || size > limit)) {
        try {
          return await openStreamSink(worker, name, size);
        } catch {
          // An older worker, or a browser that would not start the download.
        }
      }
      return memorySink(name, limit);
    },
  };
}

function currentWorker(): ServiceWorker | null {
  try {
    return typeof navigator !== "undefined" ? (navigator.serviceWorker?.controller ?? null) : null;
  } catch {
    return null;
  }
}

/** Held in memory, then handed to the browser's download in one piece. */
export function memorySink(
  name: string,
  limit: number,
  save: (blob: Blob, name: string) => void = saveBlob,
): ByteSink {
  const parts: Uint8Array[] = [];
  let total = 0;
  return {
    write: async (bytes) => {
      total += bytes.byteLength;
      if (total > limit) throw new Error(downloadTooLargeNotice(formatSize(limit)));
      parts.push(bytes.slice());
    },
    close: async () => {
      save(new Blob(parts as BlobPart[], { type: "application/octet-stream" }), name);
      parts.length = 0;
    },
    abort: async () => {
      parts.length = 0;
    },
  };
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  // Revoked once the browser has surely taken it; at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Chunks a stream may be ahead of the worker before it waits to be asked. */
const STREAM_CREDIT = 16;
const READY_MS = 3_000;
const STARTED_MS = 15_000;
const STALL_MS = 120_000;
const PING_MS = 10_000;

/**
 * A download streamed through the service worker. Resolves once the worker
 * has the route registered and the browser has actually asked for it, so a
 * worker that can't serve it is found out before any byte is committed.
 */
export async function openStreamSink(
  worker: ServiceWorker,
  name: string,
  size: number | null,
  frameHost: { appendChild(node: Node): unknown; removeChild(node: Node): unknown } = document.body,
): Promise<ByteSink> {
  const token = crypto.randomUUID();
  const channel = new MessageChannel();
  const port = channel.port1;
  let credit = 0;
  let waiting: (() => void) | null = null;
  let failure: Error | null = null;
  const handlers = new Map<string, () => void>();
  port.onmessage = ({ data }) => {
    const type = (data as { type?: unknown } | null)?.type;
    if (type === "pull") {
      credit += 1;
      waiting?.();
    } else if (type === "cancelled") {
      failure = new Error(browserStoppedSaving(name));
      waiting?.();
    } else if (typeof type === "string") handlers.get(type)?.();
  };
  const expect = (type: string, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        handlers.delete(type);
        reject(new Error(`stream ${type} timed out`));
      }, ms);
      handlers.set(type, () => {
        clearTimeout(timer);
        handlers.delete(type);
        resolve();
      });
    });
  const ready = expect("ready", READY_MS);
  worker.postMessage({ type: "spawn.stream.open", token, name, size }, [channel.port2]);
  try {
    await ready;
  } catch (error) {
    port.close();
    throw error;
  }
  const started = expect("started", STARTED_MS);
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  frame.src = `${STREAM_ROUTE}${token}`;
  frameHost.appendChild(frame);
  const removeFrame = () => {
    try {
      frameHost.removeChild(frame);
    } catch {
      // Already gone.
    }
  };
  try {
    await started;
  } catch (error) {
    removeFrame();
    port.postMessage({ type: "abort" });
    port.close();
    throw error;
  }
  credit += STREAM_CREDIT;
  // A worker idle between messages can be stopped; a ping now and then keeps
  // it serving the download.
  const ping = setInterval(() => {
    try {
      worker.postMessage({ type: "spawn.stream.ping" });
    } catch {
      // A worker gone stops the download; the stall timer says so.
    }
  }, PING_MS);
  const finish = (message: { type: string }, delay: number) => {
    clearInterval(ping);
    try {
      port.postMessage(message);
    } catch {
      // The worker is gone: the browser has already failed the download.
    }
    setTimeout(() => {
      port.close();
      removeFrame();
    }, delay);
  };
  return {
    write: async (bytes) => {
      while (credit <= 0 && !failure) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiting = null;
            reject(new Error(browserStoppedSaving(name)));
          }, STALL_MS);
          waiting = () => {
            clearTimeout(timer);
            waiting = null;
            resolve();
          };
        });
      }
      if (failure) throw failure;
      credit -= 1;
      const copy = bytes.slice();
      port.postMessage({ type: "chunk", bytes: copy }, [copy.buffer]);
    },
    close: async () => {
      if (failure) throw failure;
      finish({ type: "end" }, 30_000);
    },
    abort: async () => {
      finish({ type: "abort" }, 1_000);
    },
  };
}
