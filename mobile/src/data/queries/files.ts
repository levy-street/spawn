import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { validateDirectoryPage } from "@/components/files/pagination";
import { joinDirectory } from "@/components/files/paths";
import type { HostDirList, HostHome } from "@/components/files/types";
import { getHost, listHosts } from "@/data/api/endpoints/hosts";
import { qk } from "@/data/queryKeys";
import type { HostTransport } from "@/terminal/transport/types";

export function fetchHostHome(transport: HostTransport): Promise<HostHome> {
  return transport.request<HostHome>("fs.home");
}

export async function fetchHostDirectoryPage(
  transport: HostTransport,
  path: string,
  cursor: number,
): Promise<HostDirList> {
  const result = await transport.request<HostDirList>("fs.list", {
    ...(path ? { path } : {}),
    cursor,
  });
  return validateDirectoryPage(result, cursor);
}

export function createHostFolder(
  transport: HostTransport,
  parentPath: string,
  name: string,
): Promise<{ path: string }> {
  return transport.request("fs.mkdir", { path: joinDirectory(parentPath, name) });
}

export function renameHostEntry(
  transport: HostTransport,
  path: string,
  name: string,
): Promise<{ path: string }> {
  return transport.request("fs.rename", { path, name, overwrite: false });
}

export function removeHostEntry(
  transport: HostTransport,
  path: string,
  recursive: boolean,
): Promise<{ path: string }> {
  return transport.request("fs.remove", { path, recursive });
}

export function useFileHosts() {
  return useQuery({ queryKey: qk.hosts(), queryFn: listHosts });
}

export function useFileHost(hostId: string) {
  return useQuery({
    queryKey: qk.host(hostId),
    queryFn: () => getHost(hostId),
    enabled: hostId.length > 0,
  });
}

export function useHostHome(hostId: string, transport: HostTransport | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.hostHome(hostId),
    queryFn: () => {
      if (!transport) throw new Error("Host transport is unavailable.");
      return fetchHostHome(transport);
    },
    enabled: enabled && transport !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useHostDirectory(
  hostId: string,
  path: string,
  transport: HostTransport | null,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: qk.hostFiles(hostId, path),
    queryFn: ({ pageParam }) => {
      if (!transport) throw new Error("Host transport is unavailable.");
      return fetchHostDirectoryPage(transport, path, pageParam);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.truncated === true || typeof lastPage.next_cursor !== "number"
        ? undefined
        : lastPage.next_cursor,
    enabled: enabled && transport !== null && path.length > 0,
  });
}
