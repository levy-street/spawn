"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { handOffFolder } from "@/lib/files/folder-handoff";

/** A host's Files page. It never carries a folder: see `lib/files/folder-handoff`. */
export function hostFilesHref(hostId: string): string {
  return `/hosts/${hostId}/files`;
}

/**
 * Open a host's Files page at a folder, handing the folder over in memory so
 * it never goes into the address, a prefetch, or the browser's history.
 */
export function useOpenHostFolder(): (hostId: string, path: string | null) => void {
  const router = useRouter();
  return useCallback(
    (hostId: string, path: string | null) => {
      if (path) handOffFolder(hostId, path);
      router.push(hostFilesHref(hostId));
    },
    [router],
  );
}
