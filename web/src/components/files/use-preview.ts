"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostControlClient, HostDirEntry } from "@/lib/hostControl";
import type { FileActionCapabilities } from "@/lib/preview/capabilities";
import { classifyFile, type FileTypeInfo, PREVIEW_BUDGET } from "@/lib/preview/file-kinds";
import {
  type PreviewEntry,
  type PreviewVariant,
  previewCache,
  previewKey,
} from "@/lib/preview/preview-cache";
import { makePreviewLoader } from "@/lib/preview/preview-loaders";

/**
 * Subscribe to one preview, requesting it if nobody has yet.
 *
 * The ref is taken for exactly as long as this component renders the entry,
 * which is the whole object-URL lifetime story: nothing else decides when a
 * `blob:` URL may be revoked.
 */
export function usePreview(options: {
  client: HostControlClient | null;
  hostId: string;
  entry: Pick<HostDirEntry, "name" | "path" | "size" | "kind" | "modified_at"> | null;
  variant: PreviewVariant;
  caps: FileActionCapabilities;
  /** False while the row is not eligible — renaming, dragging, disconnected. */
  enabled?: boolean;
}): { entry: PreviewEntry | undefined; info: FileTypeInfo | null; key: string | null } {
  const { client, hostId, entry, variant, caps, enabled = true } = options;

  const info = useMemo(
    () => (entry ? classifyFile({ name: entry.name, kind: entry.kind, size: entry.size }) : null),
    [entry],
  );

  const key = useMemo(() => {
    if (!entry || !info) return null;
    if (info.kind === "none") return null;
    return previewKey({
      hostId,
      path: entry.path,
      modifiedAt: entry.modified_at,
      size: entry.size,
      variant,
    });
  }, [entry, info, hostId, variant]);

  const snapshot = useSyncExternalStore(
    previewCache.subscribe,
    () => (key ? previewCache.peek(key) : undefined),
    () => undefined,
  );

  useEffect(() => {
    if (!key || !client || !entry || !info || !enabled) return;
    // Hovering a large image is not worth a multi-megabyte fetch nobody asked
    // for; the viewer will pull it when the file is actually opened.
    const size = entry.size ?? 0;
    if (variant !== "full" && size > PREVIEW_BUDGET.hoverImage && info.kind !== "quicklook") {
      return;
    }
    previewCache.request(
      key,
      makePreviewLoader({
        client,
        entry,
        info,
        variant,
        canQuicklook: caps.quicklook,
      }),
      { hostId, priority: variant === "full" ? "modal" : "hover" },
    );
    previewCache.acquire(key);
    return () => {
      previewCache.releaseRef(key);
    };
  }, [key, client, entry, info, variant, caps.quicklook, hostId, enabled]);

  return { entry: snapshot, info, key };
}
