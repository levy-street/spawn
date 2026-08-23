import { beforeEach, describe, expect, test } from "bun:test";
import {
  configurePreviewCache,
  type PreviewLoaderContext,
  previewCache,
  previewKey,
} from "./preview-cache";

let revoked: string[] = [];
let created = 0;
let clock = 0;

beforeEach(() => {
  revoked = [];
  created = 0;
  clock = 0;
  configurePreviewCache({
    createObjectURL: () => `blob:${++created}`,
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
    now: () => ++clock,
  });
});

/** A loader whose completion the test drives by hand. */
function deferred(bytes = 10, url: string | null = "blob:x") {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let seen: PreviewLoaderContext | null = null;
  const gate = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const loader = async (context: PreviewLoaderContext) => {
    seen = context;
    await gate;
    return { mime: "image/png", bytes, url, text: null, truncated: false };
  };
  return {
    loader,
    resolve,
    reject,
    context: () => seen,
  };
}

const HOST = "host-1";

function key(path: string, variant: "thumb" | "head" | "full" = "full") {
  return previewKey({ hostId: HOST, path, modifiedAt: 100, size: 10, variant });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("previewKey", () => {
  test("identity includes mtime and size, so an edit misses", () => {
    const before = previewKey({
      hostId: HOST,
      path: "/a.png",
      modifiedAt: 1,
      size: 10,
      variant: "full",
    });
    const after = previewKey({
      hostId: HOST,
      path: "/a.png",
      modifiedAt: 2,
      size: 10,
      variant: "full",
    });
    expect(before).not.toBe(after);
  });

  test("variants of one file are distinct entries", () => {
    expect(key("/a.png", "thumb")).not.toBe(key("/a.png", "full"));
  });

  test("different hosts never collide", () => {
    const a = previewKey({
      hostId: "h1",
      path: "/a",
      modifiedAt: 1,
      size: 1,
      variant: "full",
    });
    const b = previewKey({
      hostId: "h2",
      path: "/a",
      modifiedAt: 1,
      size: 1,
      variant: "full",
    });
    expect(a).not.toBe(b);
  });
});

describe("previewCache requests", () => {
  test("dedupes a second request for the same key", async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { mime: "image/png", bytes: 1, url: "blob:a", text: null, truncated: false };
    };
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    await flush();
    expect(calls).toBe(1);
  });

  test("a completed load is readable", async () => {
    const { loader, resolve } = deferred();
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    expect(previewCache.peek(key("/a.png"))?.status).toBe("loading");
    resolve();
    await flush();
    expect(previewCache.peek(key("/a.png"))?.status).toBe("ready");
  });

  test("a failure is recorded rather than thrown", async () => {
    const { loader, reject } = deferred();
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    reject(Object.assign(new Error("nope"), { code: "preview_unavailable" }));
    await flush();
    const entry = previewCache.peek(key("/a.png"));
    expect(entry?.status).toBe("error");
    expect(entry?.status === "error" && entry.code).toBe("preview_unavailable");
  });
});

describe("previewCache concurrency", () => {
  test("only one load runs per host at a time", async () => {
    const first = deferred();
    const second = deferred();
    previewCache.request(key("/a.png"), first.loader, { hostId: HOST });
    previewCache.request(key("/b.png"), second.loader, { hostId: HOST });
    await flush();
    // The host has eight long-task permits shared with reads and writes; a
    // preview must never be able to monopolise them.
    expect(first.context()).not.toBeNull();
    expect(second.context()).toBeNull();

    first.resolve();
    await flush();
    expect(second.context()).not.toBeNull();
  });

  test("a modal pre-empts a hover in flight", async () => {
    const hover = deferred();
    const modal = deferred();
    previewCache.request(key("/a.png"), hover.loader, { hostId: HOST, priority: "hover" });
    await flush();
    previewCache.request(key("/b.png"), modal.loader, { hostId: HOST, priority: "modal" });
    expect(hover.context()?.signal.aborted).toBe(true);
  });

  test("a hover never pre-empts a modal", async () => {
    const modal = deferred();
    const hover = deferred();
    previewCache.request(key("/a.png"), modal.loader, { hostId: HOST, priority: "modal" });
    await flush();
    previewCache.request(key("/b.png"), hover.loader, { hostId: HOST, priority: "hover" });
    expect(modal.context()?.signal.aborted).toBe(false);
  });

  test("a newer hover replaces the queued one", async () => {
    const running = deferred();
    const stale = deferred();
    const fresh = deferred();
    previewCache.request(key("/a.png"), running.loader, { hostId: HOST });
    await flush();
    previewCache.request(key("/b.png"), stale.loader, { hostId: HOST });
    previewCache.request(key("/c.png"), fresh.loader, { hostId: HOST });
    running.resolve();
    await flush();
    // The row the pointer sat on last is the one worth loading.
    expect(stale.context()).toBeNull();
    expect(fresh.context()).not.toBeNull();
  });
});

describe("previewCache object URL lifetime", () => {
  test("cancel aborts the loader's signal", async () => {
    const { loader, context } = deferred();
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    await flush();
    previewCache.cancel(key("/a.png"));
    expect(context()?.signal.aborted).toBe(true);
  });

  test("clearHost revokes that host's URLs and nobody else's", async () => {
    const a = deferred(10, "blob:a");
    const b = deferred(10, "blob:b");
    previewCache.request(key("/a.png"), a.loader, { hostId: HOST });
    a.resolve();
    await flush();
    previewCache.request(
      previewKey({ hostId: "host-2", path: "/b.png", modifiedAt: 1, size: 1, variant: "full" }),
      b.loader,
      { hostId: "host-2" },
    );
    b.resolve();
    await flush();

    previewCache.clearHost(HOST);
    expect(revoked).toEqual(["blob:a"]);
    expect(previewCache.peek(key("/a.png"))).toBeUndefined();
  });

  test("a result arriving after clearHost is revoked, not leaked", async () => {
    const { loader, resolve } = deferred(10, "blob:late");
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    await flush();
    previewCache.clearHost(HOST);
    resolve();
    await flush();
    expect(revoked).toContain("blob:late");
  });

  test("a held entry is never evicted", async () => {
    // Evicting something an <img> still points at would revoke its src.
    const { loader, resolve } = deferred(200 * 1024 * 1024, "blob:big");
    previewCache.request(key("/big.png"), loader, { hostId: HOST });
    resolve();
    await flush();
    previewCache.acquire(key("/big.png"));

    const filler = deferred(200 * 1024 * 1024, "blob:filler");
    previewCache.request(key("/filler.png"), filler.loader, { hostId: HOST });
    filler.resolve();
    await flush();

    expect(revoked).not.toContain("blob:big");
    expect(previewCache.peek(key("/big.png"))?.status).toBe("ready");
  });

  test("an unheld entry is evicted and revoked once over budget", async () => {
    const first = deferred(200 * 1024 * 1024, "blob:first");
    previewCache.request(key("/first.png"), first.loader, { hostId: HOST });
    first.resolve();
    await flush();

    const second = deferred(200 * 1024 * 1024, "blob:second");
    previewCache.request(key("/second.png"), second.loader, { hostId: HOST });
    second.resolve();
    await flush();

    expect(revoked).toContain("blob:first");
  });

  test("releasing a ref makes an entry evictable again", async () => {
    const held = deferred(200 * 1024 * 1024, "blob:held");
    previewCache.request(key("/held.png"), held.loader, { hostId: HOST });
    held.resolve();
    await flush();
    previewCache.acquire(key("/held.png"));
    previewCache.releaseRef(key("/held.png"));

    const filler = deferred(200 * 1024 * 1024, "blob:filler");
    previewCache.request(key("/filler.png"), filler.loader, { hostId: HOST });
    filler.resolve();
    await flush();

    expect(revoked).toContain("blob:held");
  });
});

describe("previewCache subscriptions", () => {
  test("notifies on state changes and unsubscribes cleanly", async () => {
    let notifications = 0;
    const unsubscribe = previewCache.subscribe(() => {
      notifications += 1;
    });
    const { loader, resolve } = deferred();
    previewCache.request(key("/a.png"), loader, { hostId: HOST });
    resolve();
    await flush();
    expect(notifications).toBeGreaterThan(0);

    const seen = notifications;
    unsubscribe();
    previewCache.cancel(key("/a.png"));
    expect(notifications).toBe(seen);
  });
});
