import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memorySink, openStreamSink, STREAM_ROUTE, streamingOrMemory } from "./download-sink";

/**
 * `public/sw.js`, loaded as the browser would: its listeners land on a fake
 * `self`, and every cache or network call is recorded, so the tests can show
 * the stream route never makes one.
 */
interface FakeRegistration {
  active?: { postMessage(data: unknown, transfer?: MessagePort[]): void };
  waiting?: { postMessage(data: unknown): void };
}

function loadWorker(registration: FakeRegistration = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const calls: string[] = [];
  let skipped = 0;
  const self = {
    location: { origin: "https://spawnd.test" },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    registration,
    skipWaiting: () => {
      skipped += 1;
      return Promise.resolve();
    },
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
  };
  const caches = {
    open: async () => {
      calls.push("caches.open");
      return { put: async () => calls.push("cache.put"), addAll: async () => {} };
    },
    match: async () => {
      calls.push("caches.match");
      return undefined;
    },
    keys: async () => [],
    delete: async () => true,
  };
  const fetchStub = async (request: Request) => {
    calls.push(`fetch ${new URL(request.url).pathname}`);
    return new Response("network");
  };
  const source = readFileSync(join(import.meta.dir, "../../../public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", source)(self, caches, fetchStub);
  const fetchEvent = (path: string) => {
    let response: Promise<Response> | Response | null = null;
    listeners.get("fetch")?.({
      request: new Request(`https://spawnd.test${path}`),
      respondWith: (value: Promise<Response> | Response) => {
        response = value;
      },
    });
    return response as Promise<Response> | Response | null;
  };
  const message = (data: unknown, ports: MessagePort[] = []) =>
    listeners.get("message")?.({ data, ports });
  const install = async () => {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get("install")?.({
      waitUntil: (promise: Promise<unknown>) => {
        work = promise;
      },
    });
    await work;
  };
  return { calls, fetchEvent, message, install, skipped: () => skipped };
}

const TOKEN = "0b6f4b8e-6d5f-4f3c-9a51-2e1c2b9d7a10";

function opened(worker: ReturnType<typeof loadWorker>, name: string, size: number | null) {
  const channel = new MessageChannel();
  const page: unknown[] = [];
  channel.port1.onmessage = ({ data }) => page.push(data);
  worker.message({ type: "spawn.stream.open", token: TOKEN, name, size }, [channel.port2]);
  return { port: channel.port1, page };
}

async function until(ok: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(2);
  }
}

test("the stream route answers with the page's bytes as an attachment, from no cache and no network", async () => {
  const worker = loadWorker();
  const { port, page } = opened(worker, "naïve “report”.pdf", 11);
  await until(() => page.length > 0);
  expect(page[0]).toEqual({ type: "ready" });
  const response = await worker.fetchEvent(`${STREAM_ROUTE}${TOKEN}`);
  if (!response) throw new Error("no response");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Length")).toBe("11");
  expect(response.headers.get("Content-Disposition")).toBe(
    "attachment; filename=\"na_ve _report_.pdf\"; filename*=UTF-8''na%C3%AFve%20%E2%80%9Creport%E2%80%9D.pdf",
  );
  const body = response.text();
  port.postMessage({ type: "chunk", bytes: new TextEncoder().encode("hello ") });
  port.postMessage({ type: "chunk", bytes: new TextEncoder().encode("world") });
  port.postMessage({ type: "end" });
  expect(await body).toBe("hello world");
  // The port delivers on its own task, after the body may already have resolved.
  await until(() => page.some((data) => (data as { type: string }).type === "pull"));
  expect(page).toContainEqual({ type: "started" });
  expect(worker.calls).toEqual([]);
  // One fetch per token.
  const again = await worker.fetchEvent(`${STREAM_ROUTE}${TOKEN}`);
  expect(again?.status).toBe(404);
  expect(worker.calls).toEqual([]);
});

test("an unknown token is refused there, and nothing is asked of the network", async () => {
  const worker = loadWorker();
  const response = await worker.fetchEvent(`${STREAM_ROUTE}not-a-token`);
  expect(response?.status).toBe(404);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(worker.calls).toEqual([]);
});

test("a download stopped in the browser tells the page", async () => {
  const worker = loadWorker();
  const { page } = opened(worker, "a.bin", null);
  await until(() => page.length > 0);
  const response = await worker.fetchEvent(`${STREAM_ROUTE}${TOKEN}`);
  expect(response?.headers.get("Content-Length")).toBeNull();
  await response?.body?.cancel();
  await until(() => page.some((data) => (data as { type: string }).type === "cancelled"));
});

test("a new version waits while the one in control streams a download, then takes over", async () => {
  const registration: FakeRegistration = {};
  const old = loadWorker(registration);
  const { port, page } = opened(old, "big.bin", null);
  await until(() => page.length > 0);
  const response = await old.fetchEvent(`${STREAM_ROUTE}${TOKEN}`);
  if (!response) throw new Error("no response");
  const next = loadWorker(registration);
  registration.active = { postMessage: (data, ports) => old.message(data, ports ?? []) };
  registration.waiting = { postMessage: (data) => next.message(data) };
  await next.install();
  // Taking over now would take the download's only copy of its stream away.
  expect(next.skipped()).toBe(0);
  const body = response.text();
  port.postMessage({ type: "chunk", bytes: new TextEncoder().encode("all of it") });
  port.postMessage({ type: "end" });
  expect(await body).toBe("all of it");
  await until(() => next.skipped() === 1);
});

test("with nothing streaming, or an older version in control, a new one takes over at once", async () => {
  const registration: FakeRegistration = {};
  const idle = loadWorker(registration);
  registration.active = { postMessage: (data, ports) => idle.message(data, ports ?? []) };
  const next = loadWorker(registration);
  await next.install();
  expect(next.skipped()).toBe(1);
  // One that never answers the question (it predates it) holds nothing back.
  const silent: FakeRegistration = { active: { postMessage: () => {} } };
  const after = loadWorker(silent);
  await after.install();
  expect(after.skipped()).toBe(1);
});

test("everything else is served as before", async () => {
  const worker = loadWorker();
  await worker.fetchEvent("/_next/static/chunk.js");
  expect(worker.calls).toContain("caches.match");
  await worker.fetchEvent("/hosts");
  expect(worker.calls).toContain("fetch /hosts");
  expect(worker.fetchEvent("/api/hosts")).toBeNull();
});

// ---- The page's side --------------------------------------------------------------

const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ hidden: false, src: "", setAttribute() {} }),
    },
  });
});
afterEach(() => {
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
  else Reflect.deleteProperty(globalThis, "document");
});

/** The page and the worker wired together: a frame pointed at the route fetches through it. */
function wired() {
  const worker = loadWorker();
  const responses: Array<Promise<Response> | Response | null> = [];
  const controller = {
    postMessage: (data: unknown, transfer?: Transferable[]) =>
      worker.message(
        data,
        (transfer ?? []).filter((item) => item instanceof MessagePort),
      ),
  } as unknown as ServiceWorker;
  const frames = {
    appendChild: (node: Node) => {
      const src = (node as unknown as { src: string }).src;
      responses.push(worker.fetchEvent(src));
    },
    removeChild: () => {},
  };
  return { worker, controller, frames, responses };
}

test("a streamed download carries every byte the page writes, in order", async () => {
  const { controller, frames, responses, worker } = wired();
  const sink = await openStreamSink(controller, "big.bin", 70_000, frames);
  const response = await responses[0];
  if (!response) throw new Error("no response");
  const body = response.arrayBuffer();
  const data = Uint8Array.from({ length: 70_000 }, (_, i) => i % 253);
  for (let at = 0; at < data.length; at += 4_096) await sink.write(data.subarray(at, at + 4_096));
  await sink.close();
  expect(new Uint8Array(await body)).toEqual(data);
  expect(worker.calls).toEqual([]);
});

test("a worker without the route is found out before any byte, and memory takes over", async () => {
  const silent = { postMessage: () => {} } as unknown as ServiceWorker;
  const saved: Array<{ blob: Blob; name: string }> = [];
  await expect(
    openStreamSink(silent, "a.bin", 10, { appendChild() {}, removeChild() {} }),
  ).rejects.toThrow();
  const fallback = memorySink("a.bin", 32, (blob, name) => saved.push({ blob, name }));
  await fallback.write(new TextEncoder().encode("small"));
  await fallback.close();
  expect(saved[0]?.name).toBe("a.bin");
  expect(await saved[0]?.blob.text()).toBe("small");
}, 10_000);

test("memory says plainly when a download is too big for it", async () => {
  const sink = memorySink("a.bin", 4, () => {});
  await expect(sink.write(new Uint8Array(5))).rejects.toThrow(
    "This browser can only save up to 4 B at a time from SPAWN D. Reload the page and try again, or use Chrome or Edge.",
  );
});

test("small downloads stay in memory; only big ones use the worker, and only if there is one", async () => {
  expect(streamingOrMemory(null, 100).limit).toBe(100);
  const { controller, frames } = wired();
  const opener = streamingOrMemory(controller, 100);
  expect(opener.limit).toBeNull();
  void frames;
});
