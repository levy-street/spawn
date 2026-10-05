import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type ChangeProbe,
  createFolderChecked,
  type HeldFolder,
  renameChecked,
} from "@/components/files/change-check";
import { fileErrorCode } from "@/components/files/errors";
import {
  applyFirstPagePoll,
  type DirectoryListing,
  drainDirectory,
} from "@/components/files/listing";
import { validateDirectoryPage } from "@/components/files/pagination";
import { joinDirectory, type PathFlavor } from "@/components/files/paths";
import type { HostDirEntry, HostDirList, HostHome } from "@/components/files/types";
import { getHost, listHosts } from "@/data/api/endpoints/hosts";
import { qk } from "@/data/queryKeys";
import type {
  AgentTranscriptQuery,
  AgentTranscriptReport,
  HostTransport,
  HostWriteResult,
} from "@/terminal/transport/types";

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

/** Every page of a folder, up to the host's 1,024-entry limit. */
export function fetchHostListing(
  transport: HostTransport,
  path: string,
): Promise<DirectoryListing> {
  return drainDirectory((cursor) => fetchHostDirectoryPage(transport, path, cursor));
}

/**
 * Whether the host said it can do `operation`. A transport that cannot say —
 * a test double, an older client build — is taken at its word that it can,
 * and the host refuses what it cannot do.
 */
export function hostCan(transport: HostTransport | null, operation: string): boolean {
  if (!transport) return false;
  return transport.hasCapability ? transport.hasCapability(operation) : true;
}

/** What the host says is at `path`, without listing its folder. */
export function statHostEntry(
  transport: HostTransport,
  path: string,
): Promise<{ path: string; name: string; kind: string }> {
  return transport.request("fs.stat", { path });
}

/** How a change the host could not vouch for is looked into (change-check.ts). */
function changeProbe(transport: HostTransport): ChangeProbe {
  return {
    stat: hostCan(transport, "fs.stat") ? (path) => statHostEntry(transport, path) : null,
    codeOf: fileErrorCode,
  };
}

/**
 * A new folder, never one already there: the host's mkdir would answer that
 * as made. `held` is the folder's listing on screen, which answers first.
 */
export async function createHostFolder(
  transport: HostTransport,
  parentPath: string,
  name: string,
  pathFlavor: PathFlavor,
  held: HeldFolder | null,
): Promise<{ path: string }> {
  const path = joinDirectory(parentPath, name, pathFlavor);
  return {
    path: await createFolderChecked({
      path,
      name,
      held,
      mkdir: async () =>
        (await transport.request<{ path?: string | null }>("fs.mkdir", { path })).path ?? path,
      probe: changeProbe(transport),
    }),
  };
}

/**
 * Renames an item in `parentPath` without replacing anything. A name already
 * taken is said as that, even when the host's own answer was only that it
 * could not be sure what happened.
 */
export async function renameHostEntry(
  transport: HostTransport,
  entry: Pick<HostDirEntry, "name" | "path">,
  name: string,
  parentPath: string,
  pathFlavor: PathFlavor,
  held: HeldFolder | null,
): Promise<{ path: string }> {
  const to = joinDirectory(parentPath, name, pathFlavor);
  return {
    path: await renameChecked({
      from: entry.path,
      fromName: entry.name,
      to,
      name,
      held,
      rename: async () =>
        (
          await transport.request<{ path?: string | null }>("fs.rename", {
            path: entry.path,
            name,
            overwrite: false,
          })
        ).path ?? to,
      probe: changeProbe(transport),
    }),
  };
}

export function removeHostEntry(
  transport: HostTransport,
  path: string,
  recursive: boolean,
): Promise<{ path: string }> {
  return transport.request("fs.remove", { path, recursive });
}

export function canCreateHostFile(transport: HostTransport | null): boolean {
  return hostCan(transport, "fs.write.begin") && typeof transport?.writeFile === "function";
}

const EMPTY_FILE = { size: 0, read: async () => new Uint8Array(0) } as const;

/**
 * A new, empty file: a zero-length write that refuses to replace anything
 * already there, so "New file" can never truncate one.
 */
export function createHostFile(
  transport: HostTransport,
  parentPath: string,
  name: string,
): Promise<HostWriteResult> {
  if (!transport.writeFile) {
    return Promise.reject(new Error("This host connection cannot create files."));
  }
  return transport.writeFile(EMPTY_FILE, { dir: parentPath, name, overwrite: false });
}

export interface RemoveHostEntriesResult {
  removed: HostDirEntry[];
  failed: { entry: HostDirEntry; error: unknown }[];
}

/**
 * Deletes each entry in turn and reports every outcome; one refusal does not
 * stop the rest. The channel's queue is serial, so asking in parallel would
 * only queue the same requests behind one another.
 */
export async function removeHostEntries(
  transport: HostTransport,
  entries: readonly HostDirEntry[],
): Promise<RemoveHostEntriesResult> {
  const result: RemoveHostEntriesResult = { removed: [], failed: [] };
  for (const entry of entries) {
    try {
      await removeHostEntry(transport, entry.path, entry.is_dir);
      result.removed.push(entry);
    } catch (error) {
      result.failed.push({ entry, error });
    }
  }
  return result;
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

/** Answers to a look at a folder that asking again will not change: the folder is gone or shut. */
const FINAL_LIST_ERRORS: ReadonlySet<string> = new Set([
  "outside_root",
  "traversal_rejected",
  "not_found",
  "not_directory",
  "symlink_rejected",
  "permission_denied",
  "invalid_path",
]);

export function isFinalListError(error: unknown): boolean {
  const code = fileErrorCode(error);
  return code !== null && FINAL_LIST_ERRORS.has(code);
}

/**
 * A folder, read to its end. Always stale: each time the folder comes back into
 * view — a channel reopened, the screen on top popped — it is read again, and
 * otherwise only on a refresh or after this device changes it.
 */
export function useHostListing(
  hostId: string,
  path: string,
  transport: HostTransport | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: qk.hostFiles(hostId, path),
    queryFn: () => {
      if (!transport) throw new Error("Host transport is unavailable.");
      return fetchHostListing(transport, path);
    },
    enabled: enabled && transport !== null && path.length > 0,
    staleTime: 0,
    // A folder that is gone or shut answers the same again; anything else gets one more try.
    retry: (failures, error) => !isFinalListError(error) && failures < 1,
  });
}

/** How often a folder on screen looks at its first page again, on a host without fs.watch. */
export const HOST_LISTING_POLL_MS = 10_000;

/**
 * Looks at page 1 of a folder on screen every ten seconds and folds what it
 * sees into the listing (`applyFirstPagePoll`): one request a tick, and a full
 * read only when a one-page folder has grown past its page. A folder that has
 * gone or been shut is read in full too, so it shows why rather than its old
 * rows. Skips a tick while the folder is being read in full.
 */
export function useHostListingPoll(
  hostId: string,
  path: string,
  transport: HostTransport | null,
  enabled: boolean,
  intervalMs = HOST_LISTING_POLL_MS,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || !transport || !path) return;
    const queryKey = qk.hostFiles(hostId, path);
    let stopped = false;
    let polling = false;
    const tick = async () => {
      if (polling || queryClient.isFetching({ queryKey }) > 0) return;
      const before = queryClient.getQueryData<DirectoryListing>(queryKey);
      if (!before) return;
      polling = true;
      try {
        const page = await fetchHostDirectoryPage(transport, path, 0);
        // A full read that landed meanwhile already knows better than this page.
        if (stopped || queryClient.getQueryData<DirectoryListing>(queryKey) !== before) return;
        const outcome = applyFirstPagePoll(before, page);
        if (outcome.kind === "reread") {
          void queryClient.invalidateQueries({ queryKey, exact: true });
        } else if (outcome.kind !== "same") {
          queryClient.setQueryData(queryKey, outcome.listing);
        }
      } catch (error) {
        // A missed look is taken again next tick. A folder that vanished or
        // was shut is read in full, which shows why.
        if (!stopped && isFinalListError(error)) {
          void queryClient.invalidateQueries({ queryKey, exact: true });
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [enabled, hostId, intervalMs, path, queryClient, transport]);
}

/**
 * The agent's own record of a window's conversation, located by the daemon.
 * A transport without the method is an older client build; an older daemon
 * answers `unsupported_operation` itself.
 */
export function fetchAgentTranscripts(
  transport: HostTransport,
  query: AgentTranscriptQuery,
): Promise<AgentTranscriptReport> {
  if (!transport.agentTranscripts) {
    throw new Error("This host connection cannot locate transcripts.");
  }
  return transport.agentTranscripts(query);
}

export function useAgentTranscripts(
  sessionId: string,
  transport: HostTransport | null,
  query: AgentTranscriptQuery | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: qk.agentTranscripts(sessionId, query?.conversationId ?? null, query?.cwd ?? null),
    queryFn: () => {
      if (!transport || !query) throw new Error("Host transport is unavailable.");
      return fetchAgentTranscripts(transport, query);
    },
    enabled: enabled && transport !== null && query !== null,
    // Every opening is a fresh look: the agent writes as it goes.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
