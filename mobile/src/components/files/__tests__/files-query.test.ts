import {
  canCreateHostFile,
  createHostFile,
  fetchHostDirectoryPage,
  fetchHostListing,
  hostCan,
  removeHostEntries,
} from "@/data/queries/files";
import type { HostTransport } from "@/terminal/transport/types";

function transport(result: unknown): HostTransport {
  const request = jest.fn(async () => result) as unknown as HostTransport["request"];
  return {
    hostId: "host",
    state: "ready",
    open: async () => undefined,
    close: () => undefined,
    request,
    cancel: () => undefined,
    on: jest.fn(() => () => undefined) as HostTransport["on"],
  };
}

describe("host directory query", () => {
  it("sends an explicit cursor and returns no reordered entries", async () => {
    const value = {
      path: "/home/me",
      home_dir: "/home/me",
      entries: [
        { name: "z", path: "/home/me/z", kind: "file", is_dir: false },
        { name: "a", path: "/home/me/a", kind: "file", is_dir: false },
      ],
      next_cursor: 96,
    };
    const host = transport(value);
    const page = await fetchHostDirectoryPage(host, "/home/me", 0);
    expect(host.request).toHaveBeenCalledWith("fs.list", { path: "/home/me", cursor: 0 });
    expect(page.entries.map(({ name }) => name)).toEqual(["z", "a"]);
  });
});

describe("host file operations", () => {
  test("a listing reads every page through the same validation", async () => {
    const pages: Record<number, unknown> = {
      0: {
        path: "/home/me",
        home_dir: "/home/me",
        entries: [{ name: "a", path: "/home/me/a", kind: "file", is_dir: false }],
        next_cursor: 1,
      },
      1: {
        path: "/home/me",
        home_dir: "/home/me",
        entries: [{ name: "b", path: "/home/me/b", kind: "file", is_dir: false }],
        next_cursor: null,
      },
    };
    const request = jest.fn(
      async (_operation: string, params: { cursor: number }) => pages[params.cursor],
    );
    const host = { ...transport(null), request: request as unknown as HostTransport["request"] };
    const listing = await fetchHostListing(host, "/home/me");
    expect(listing.entries.map(({ name }) => name)).toEqual(["a", "b"]);
    expect(listing.singlePage).toBe(false);
  });

  test("a host's word on what it can do, and a transport that cannot say is taken at its word", () => {
    const plain = transport(null);
    expect(hostCan(plain, "fs.mkdir")).toBe(true);
    expect(hostCan(null, "fs.mkdir")).toBe(false);
    const gated = { ...plain, hasCapability: (operation: string) => operation === "fs.list" };
    expect(hostCan(gated, "fs.mkdir")).toBe(false);
    expect(canCreateHostFile(plain)).toBe(false);
    expect(canCreateHostFile({ ...plain, writeFile: jest.fn() })).toBe(true);
  });

  test("New file is an empty write that refuses to replace", async () => {
    const writeFile = jest.fn(async () => ({ path: "/home/me/x", length: 0, sha256: "e3" }));
    const host = { ...transport(null), writeFile };
    await createHostFile(host, "/home/me", "x");
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ size: 0 }), {
      dir: "/home/me",
      name: "x",
      overwrite: false,
    });
    await expect(createHostFile(transport(null), "/home/me", "x")).rejects.toThrow(
      "This host connection cannot create files.",
    );
  });

  test("a bulk delete carries on past a refusal and reports each outcome", async () => {
    const request = jest.fn(async (_operation: string, params: { path: string }) => {
      if (params.path.endsWith("locked"))
        throw Object.assign(new Error("no"), { code: "permission_denied" });
      return { path: params.path };
    });
    const host = { ...transport(null), request: request as unknown as HostTransport["request"] };
    const entries = [
      { name: "dir", path: "/home/me/dir", kind: "directory", is_dir: true },
      { name: "locked", path: "/home/me/locked", kind: "file", is_dir: false },
      { name: "z", path: "/home/me/z", kind: "file", is_dir: false },
    ] as const;
    const result = await removeHostEntries(host, entries);
    expect(result.removed.map(({ name }) => name)).toEqual(["dir", "z"]);
    expect(result.failed.map(({ entry }) => entry.name)).toEqual(["locked"]);
    expect(request).toHaveBeenNthCalledWith(1, "fs.remove", {
      path: "/home/me/dir",
      recursive: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, "fs.remove", {
      path: "/home/me/z",
      recursive: false,
    });
  });
});
