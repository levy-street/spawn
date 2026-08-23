import { fetchHostDirectoryPage } from "@/data/queries/files";
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
