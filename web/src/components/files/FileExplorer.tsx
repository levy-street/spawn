"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import { FileBrowser, type FileBrowserHandle } from "@/components/files/FileBrowser";

export { formatSize } from "@/lib/files/format";

/** Imperative surface for hosts that fold the explorer's actions into their
 *  own single header row (widget pane, files aside). */
export type FileExplorerHandle = {
  newFolder: () => void;
  upload: () => void;
  uploadFolder: () => void;
  refresh: () => void;
  collapseAll: () => void;
};

/**
 * The file explorer as its callers have always known it — same props, same
 * handle — drawn by `FileBrowser`. A caller that carries its own header
 * (`hideHeader`: the workspace pane, the session aside) gets the `pane`
 * layout; anything else gets the full `page` browser.
 */
export const FileExplorer = forwardRef<
  FileExplorerHandle,
  {
    hostId: string;
    /** Directory the tree is rooted at; defaults to the daemon home dir. */
    rootPath?: string;
    rootLabel?: string;
    /** Deep link: a folder opens there; a file opens its folder, selected. */
    initialPath?: string;
    dense?: boolean;
    /** The host renders its own single-row header (and reaches the actions
     *  through the ref); the explorer's toolbar is dropped. */
    hideHeader?: boolean;
    className?: string;
    /** The folder on screen changed because someone navigated. */
    onPathChange?: (path: string) => void;
    /** The workspace it sits in: a window opened from its folders lands there. */
    workspaceId?: string | null;
  }
>(function FileExplorer(
  {
    hostId,
    rootPath,
    rootLabel,
    initialPath,
    hideHeader = false,
    className,
    onPathChange,
    workspaceId,
  },
  handleRef,
) {
  const browserRef = useRef<FileBrowserHandle>(null);
  useImperativeHandle(
    handleRef,
    () => ({
      newFolder: () => browserRef.current?.newFolder(),
      upload: () => browserRef.current?.upload(),
      uploadFolder: () => browserRef.current?.uploadFolder(),
      refresh: () => browserRef.current?.refresh(),
      collapseAll: () => browserRef.current?.collapseAll(),
    }),
    [],
  );
  return (
    <FileBrowser
      ref={browserRef}
      hostId={hostId}
      layout={hideHeader ? "pane" : "page"}
      rootPath={rootPath}
      rootLabel={rootLabel}
      initialPath={initialPath}
      className={className}
      onPathChange={onPathChange}
      workspaceId={workspaceId}
    />
  );
});
