"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileBrowser } from "@/components/files/FileBrowser";
import {
  FOLDER_STATE_KEY,
  folderFromHistoryState,
  historyStateWithFolder,
  initialFolder,
  takeHandedOffFolder,
} from "@/lib/files/folder-handoff";
import { cn } from "@/lib/utils";

/** The address without `?path=`: an inbound link is read once, then dropped. */
function addressWithoutPath(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("path");
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

/**
 * A host's Files: the full-page browser, and where it opens. Whatever frame
 * holds it (the /hosts/[id]/files page, a host's Files section) owns the
 * height; this fills it.
 *
 * The folder on screen never goes into the URL — a host path is protected
 * content, and a URL reaches the server's logs, every prefetch and RSC
 * request, the browser's history and the next site's Referer
 * (`lib/files/folder-handoff.ts`). It opens at, in order: a folder handed
 * over in memory by the in-app link that brought it here, an inbound
 * `?path=` link (read once, then dropped from the address), or the folder
 * this tab's history entry was last showing (a reload, or Back).
 */
export function HostFilesBrowser({ hostId, className }: { hostId: string; className?: string }) {
  // Only ever read: nothing here writes a folder into the address.
  const linked = useSearchParams()?.get("path") ?? null;

  // Decided on the client, once per host, so it can read the tab's history.
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [decided, setDecided] = useState(false);
  const decidedFor = useRef<string | null>(null);
  /** The folder the browser last reported on screen. */
  const shownPath = useRef<string | null>(null);

  useEffect(() => {
    if (linked !== null) {
      setDeepLink(takeHandedOffFolder(hostId) ?? linked);
      setDecided(true);
      decidedFor.current = hostId;
      // Through the router's own history hook (no `__NA` in the state), so the
      // address the router holds loses the path too and nothing puts it back.
      // A tick later, once the router has hooked the history API.
      const timer = window.setTimeout(() => {
        window.history.replaceState(
          {
            [FOLDER_STATE_KEY]: {
              hostId,
              path: folderFromHistoryState(window.history.state, hostId) ?? linked,
            },
          },
          "",
          addressWithoutPath(),
        );
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (decidedFor.current === hostId) return;
    decidedFor.current = hostId;
    setDeepLink(
      initialFolder({
        handedOff: takeHandedOffFolder(hostId),
        linked: null,
        kept: folderFromHistoryState(window.history.state, hostId),
      }),
    );
    setDecided(true);
  }, [hostId, linked]);

  // The folder on screen is kept with this tab's history entry, beside the
  // router's own state and never in the URL. (`__NA` is spread along, so the
  // router lets the write through without touching the address.)
  const onPathChange = useCallback(
    (path: string) => {
      shownPath.current = path;
      window.history.replaceState(historyStateWithFolder(window.history.state, hostId, path), "");
    },
    [hostId],
  );

  // The router rewrites the entry's state on some of its own updates (a dev
  // refresh, a replace), dropping what it did not put there; as the page goes,
  // the folder is written once more so a reload or Back still finds it.
  useEffect(() => {
    const keep = () => {
      const path = shownPath.current;
      if (path && folderFromHistoryState(window.history.state, hostId) !== path) {
        window.history.replaceState(historyStateWithFolder(window.history.state, hostId, path), "");
      }
    };
    window.addEventListener("pagehide", keep);
    return () => window.removeEventListener("pagehide", keep);
  }, [hostId]);

  if (!decided) return <div className={cn("min-h-0 flex-1", className)} />;
  return (
    <FileBrowser
      key={hostId}
      hostId={hostId}
      layout="page"
      initialPath={deepLink ?? undefined}
      onPathChange={onPathChange}
      className={cn("min-h-0 flex-1", className)}
    />
  );
}
