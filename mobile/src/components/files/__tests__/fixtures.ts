import type { HostDirEntry, HostDirList } from "@/components/files/types";
import type { HostFileSource, HostTransport, HostWriteResult } from "@/terminal/transport/types";

export function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function fileEntry(folder: string, name: string, extra: Partial<HostDirEntry> = {}) {
  return { name, path: `${folder}/${name}`, kind: "file", is_dir: false, ...extra } as const;
}

export function folderEntry(folder: string, name: string, extra: Partial<HostDirEntry> = {}) {
  return { name, path: `${folder}/${name}`, kind: "directory", is_dir: true, ...extra } as const;
}

interface FakeRequestParams {
  path?: string;
  cursor?: number;
  name?: string;
  recursive?: boolean;
}

export interface FakeHostOptions {
  home?: string;
  folders?: Record<string, HostDirEntry[]>;
  /** What the hello advertises; `null` is a transport that cannot say. */
  capabilities?: readonly string[] | null;
  /** Paths whose fs.remove the host refuses. */
  refuseRemove?: ReadonlySet<string>;
  /** Runs before each request is answered: to hold it, or to throw the host's refusal. */
  before?: (operation: string, params: FakeRequestParams) => Promise<void> | void;
}

const DEFAULT_CAPABILITIES = ["fs.list", "fs.mkdir", "fs.rename", "fs.remove", "fs.write.begin"];

/**
 * A v1 host's file service, in memory: pages of 96, at most 1,024 listed, and
 * the error codes the daemon answers with.
 */
export function fakeHost({
  home = "/home/me",
  folders = {},
  capabilities = DEFAULT_CAPABILITIES,
  refuseRemove = new Set(),
  before,
}: FakeHostOptions = {}) {
  const tree = new Map<string, HostDirEntry[]>(Object.entries(folders));
  if (!tree.has(home)) tree.set(home, []);
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const list = (path: string, cursor: number): HostDirList => {
    const entries = tree.get(path);
    if (!entries) {
      const isFile = tree
        .get(parentOf(path))
        ?.some((entry) => entry.path === path && !entry.is_dir);
      throw fsError(isFile ? "not_directory" : "not_found");
    }
    const end = Math.min(cursor + 96, 1024, entries.length);
    const more = end < Math.min(entries.length, 1024);
    return {
      path,
      home_dir: home,
      entries: entries.slice(cursor, end),
      next_cursor: more ? end : null,
      truncated: !more && entries.length > 1024,
    };
  };
  const request = jest.fn(async (operation: string, params: FakeRequestParams = {}) => {
    await before?.(operation, params);
    switch (operation) {
      case "fs.home":
        return { home_dir: home };
      case "fs.list":
        return list(String(params.path ?? home), Number(params.cursor ?? 0));
      case "fs.mkdir": {
        const path = String(params.path);
        const parent = tree.get(parentOf(path));
        if (!parent) throw fsError("not_found");
        if (parent.some((entry) => entry.path === path)) throw fsError("already_exists");
        parent.push(folderEntry(parentOf(path), path.slice(path.lastIndexOf("/") + 1)));
        tree.set(path, []);
        return { path };
      }
      case "fs.rename": {
        const path = String(params.path);
        const parentPath = parentOf(path);
        const parent = tree.get(parentPath) ?? [];
        const index = parent.findIndex((entry) => entry.path === path);
        const current = parent[index];
        if (!current) throw fsError("not_found");
        const renamed = {
          ...current,
          name: String(params.name),
          path: `${parentPath}/${params.name}`,
        };
        parent[index] = renamed;
        return { path: renamed.path };
      }
      case "fs.remove": {
        const path = String(params.path);
        if (refuseRemove.has(path)) throw fsError("permission_denied");
        const parent = tree.get(parentOf(path)) ?? [];
        const index = parent.findIndex((entry) => entry.path === path);
        if (index < 0) throw fsError("not_found");
        parent.splice(index, 1);
        tree.delete(path);
        return { path };
      }
      default:
        throw fsError("unsupported_operation");
    }
  });
  const writeFile = jest.fn(
    async (
      source: HostFileSource,
      destination: { dir: string; name: string; overwrite?: boolean },
    ): Promise<HostWriteResult> => {
      const parent = tree.get(destination.dir);
      if (!parent) throw fsError("not_found");
      const path = `${destination.dir}/${destination.name}`;
      if (!destination.overwrite && parent.some((entry) => entry.path === path)) {
        throw fsError("already_exists");
      }
      parent.push(fileEntry(destination.dir, destination.name, { size: source.size }));
      return { path, length: source.size, sha256: "e3b0" };
    },
  );
  const transport: HostTransport = {
    hostId: "host-1",
    state: "ready",
    open: async () => undefined,
    close: () => undefined,
    request: request as unknown as HostTransport["request"],
    cancel: () => undefined,
    on: (() => () => undefined) as HostTransport["on"],
    writeFile,
    ...(capabilities === null
      ? {}
      : { hasCapability: (operation: string) => capabilities.includes(operation) }),
  };
  return { transport, tree, request, writeFile };
}

/** Requests the fake host was asked, as `operation path` strings, for terse assertions. */
export function requestLog(request: jest.Mock): string[] {
  return request.mock.calls.map(([operation, params]) => {
    const values = (params ?? {}) as FakeRequestParams;
    return [operation, values.path, values.cursor].filter((part) => part !== undefined).join(" ");
  });
}
