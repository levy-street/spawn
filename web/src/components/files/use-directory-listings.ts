"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  createV1DrainSource,
  type DirectoryListing,
  type DirectorySource,
} from "@/lib/files/listing";
import type { TreeFolderState } from "@/lib/files/tree";
import { type HostControlClient, HostControlError } from "@/lib/hostControl";

/**
 * Folder listings for one browser, kept true to the disk at the cadence the
 * fleet can afford (docs: "Polling cadence" in the session-host plan).
 *
 * - A folder is drained once when it is first shown — every page, up to the
 *   host's 1,024 cap — so it can be sorted as a whole.
 * - While the tab is visible, page one of each folder on screen is re-read
 *   every 10 s, and every 30 s while the tab is hidden. One request a
 *   folder: a folder that fits on one page is replaced exactly; one bigger
 *   than a page whose first page moved is marked `changedOnHost` and says so
 *   ("This folder changed on <host>." with Refresh) instead of showing rows
 *   that may be gone as if they were live.
 * - A full read happens again on an explicit refresh, when the tab comes back
 *   into focus, and after this device's own changes.
 *
 * The old explorer re-listed every open folder every 3 s, which an idle tab
 * paid for forever.
 */

export const VISIBLE_POLL_MS = 10_000;
export const HIDDEN_POLL_MS = 30_000;
/** Focus and visibility both fire on a tab switch; one refresh answers both. */
const FOCUS_REFRESH_GAP_MS = 5_000;

/** Answers that will not change by asking again. */
const FINAL_LIST_ERRORS = new Set([
  "outside_root",
  "traversal_rejected",
  "not_found",
  "not_directory",
  "symlink_rejected",
  "permission_denied",
  "invalid_path",
]);

export function isFinalListError(error: unknown): boolean {
  return error instanceof HostControlError && FINAL_LIST_ERRORS.has(error.code);
}

export function listingKey(hostId: string, path: string) {
  return ["host-files", hostId, "dir", path] as const;
}

export function useDirectoryListings({
  hostId,
  client,
  ready,
  paths,
  pollPaths,
  paused,
}: {
  hostId: string;
  client: HostControlClient | null;
  ready: boolean;
  /** Every folder the view needs listed. */
  paths: readonly string[];
  /** The subset on screen, which polling and focus refresh keep current. */
  pollPaths: readonly string[];
  /** Hold polling while a list that shifts would pull a row out from under someone. */
  paused: boolean;
}) {
  const qc = useQueryClient();
  const source = useMemo<DirectorySource | null>(
    () =>
      client
        ? createV1DrainSource((path, cursor, signal) => client.listPage(path, cursor, { signal }))
        : null,
    [client],
  );
  const enabled = ready && source !== null;

  // Combined so an answer that changed nothing hands back the same map, and
  // nothing downstream re-sorts a thousand rows for a poll that moved nothing.
  const combine = useCallback(
    (results: Array<{ data?: DirectoryListing; error: unknown; isFetching: boolean }>) => {
      const folders = new Map<string, TreeFolderState>();
      paths.forEach((path, index) => {
        const result = results[index];
        folders.set(path, {
          listing: result?.data,
          // Not `isLoading`: a query waiting on the channel is pending but not
          // fetching, and must still read as loading rather than empty.
          loading: !result?.data && !result?.error,
          error: result?.error ?? null,
        });
      });
      return { folders, fetching: results.some((result) => result.isFetching) };
    },
    [paths],
  );

  const { folders, fetching } = useQueries({
    queries: paths.map((path) => ({
      queryKey: listingKey(hostId, path),
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        if (!source) throw new HostControlError("connection_closed", "Host is not connected");
        return source.drain(path, signal);
      },
      enabled,
      staleTime: VISIBLE_POLL_MS,
      gcTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (failures: number, error: unknown) => !isFinalListError(error) && failures < 1,
    })),
    combine,
  });

  const latest = useRef({ pollPaths, paused, source });
  latest.current = { pollPaths, paused, source };

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      timer = setTimeout(tick, hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
    };
    const tick = async () => {
      const { pollPaths: due, paused: held, source: current } = latest.current;
      if (!held && current) {
        for (const path of due) {
          if (stopped) return;
          const key = listingKey(hostId, path);
          const known = qc.getQueryData<DirectoryListing>(key);
          if (!known || qc.getQueryState(key)?.fetchStatus === "fetching") continue;
          try {
            const next = await current.poll(known);
            // A full read that landed meanwhile is fresher than this page.
            if (!stopped && next !== known && qc.getQueryData(key) === known) {
              qc.setQueryData(key, next);
            }
          } catch (error) {
            // A folder that vanished or closed is shown as such by a full read.
            if (!stopped && isFinalListError(error)) {
              void qc.invalidateQueries({ queryKey: key, exact: true });
            }
          }
        }
      }
      if (!stopped) schedule();
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, hostId, qc]);

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < FOCUS_REFRESH_GAP_MS) return;
      last = now;
      const { pollPaths: due, paused: held } = latest.current;
      if (held) return;
      for (const path of due) {
        void qc.invalidateQueries({ queryKey: listingKey(hostId, path), exact: true });
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, hostId, qc]);

  /** Read a folder again in full: after a change this device made, or on request. */
  const refresh = useCallback(
    (path: string) => qc.invalidateQueries({ queryKey: listingKey(hostId, path), exact: true }),
    [hostId, qc],
  );

  const refreshAll = useCallback(
    () => qc.invalidateQueries({ queryKey: ["host-files", hostId, "dir"] }),
    [hostId, qc],
  );

  /** List a folder before going there, so a refusal can be said in place. */
  const prefetch = useCallback(
    (path: string) => {
      if (!source) {
        return Promise.reject(new HostControlError("connection_closed", "Host is not connected"));
      }
      return qc.fetchQuery({
        queryKey: listingKey(hostId, path),
        queryFn: ({ signal }) => source.drain(path, signal),
        staleTime: VISIBLE_POLL_MS,
        retry: false,
      });
    },
    [hostId, qc, source],
  );

  return { folders, fetching, refresh, refreshAll, prefetch };
}
