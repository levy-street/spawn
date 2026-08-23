"use client";

import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderSearch,
  Maximize2,
  MoreHorizontal,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { formatSize } from "@/components/files/FileExplorer";
import { FileIcon } from "@/components/files/file-icon";
import {
  CodeLines,
  ImagePreview,
  LoadingPreview,
  MarkdownPreview,
  MediaPreview,
  MetadataCard,
  PdfPreview,
  PreviewActions,
  previewErrorNote,
} from "@/components/files/preview-renderers";
import { usePreview } from "@/components/files/use-preview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { HostControlClient, HostDirEntry } from "@/lib/hostControl";
import type { FileActionCapabilities } from "@/lib/preview/capabilities";
import { isTextKind } from "@/lib/preview/file-kinds";
import { previewCache } from "@/lib/preview/preview-cache";
import { cn } from "@/lib/utils";

/**
 * The full file viewer.
 *
 * Mounted inside the explorer rather than as a global singleton host, because
 * it needs a live `HostControlClient` and the sibling row list. A global host
 * would have to call `useHostControl` itself, and that hook memoises a *new*
 * client per call site — a second RTC session per host, paid on first open.
 */
export function FileViewerDialog({
  open,
  hostId,
  entry,
  client,
  caps,
  hasPrev,
  hasNext,
  relativePath,
  onNavigate,
  onClose,
  onDownload,
  onReveal,
  onOpenExternal,
  onCopyPath,
}: {
  open: boolean;
  hostId: string;
  entry: HostDirEntry | null;
  client: HostControlClient | null;
  caps: FileActionCapabilities;
  hasPrev: boolean;
  hasNext: boolean;
  relativePath: string;
  onNavigate: (delta: -1 | 1) => void;
  onClose: () => void;
  onDownload: () => void;
  onReveal: () => void;
  onOpenExternal: () => void;
  onCopyPath: () => void;
}) {
  const [fit, setFit] = useState(true);
  const [renderFailed, setRenderFailed] = useState(false);
  const [confirmedLoad, setConfirmedLoad] = useState(false);

  // A new file is a new decision about zoom, codec support and budget.
  useEffect(() => {
    setFit(true);
    setRenderFailed(false);
    setConfirmedLoad(false);
  }, []);

  const oversize = entry?.size != null && entry.size > 0 ? entry.size : 0;

  const {
    entry: preview,
    info,
    key,
  } = usePreview({
    client,
    hostId,
    entry,
    variant: "full",
    caps,
    enabled: open && (confirmedLoad || withinBudget(entry)),
  });

  if (!entry || !info) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Arrows still belong to whatever is scrolling or scrubbing under them.
    const target = event.target as Element | null;
    if (target?.closest("[data-preview-scroll] :is(pre,textarea,input,video,audio,embed)")) {
      return;
    }
    event.preventDefault();
    onNavigate(event.key === "ArrowLeft" ? -1 : 1);
  };

  const isImage = info.kind === "image" || info.kind === "svg" || info.kind === "quicklook";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="viewer"
        hideClose
        className="p-0"
        onOpenAutoFocus={(event) => {
          // Focus the body, so the arrow keys work the moment it opens.
          event.preventDefault();
          (event.currentTarget as HTMLElement)
            .querySelector<HTMLElement>("[data-preview-scroll]")
            ?.focus();
        }}
        onKeyDown={onKeyDown}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
          <FileIcon
            name={entry.name}
            kind={entry.kind}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <DialogTitle className="min-w-0 truncate text-[13px]">{entry.name}</DialogTitle>
          <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
            {info.label}
          </span>
          {entry.size != null && (
            <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">
              {formatSize(entry.size)}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Previous file"
              disabled={!hasPrev}
              onClick={() => onNavigate(-1)}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Next file"
              disabled={!hasNext}
              onClick={() => onNavigate(1)}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>

            {isImage && preview?.status === "ready" && preview.url && (
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={fit ? "Actual size" : "Fit to window"}
                aria-pressed={!fit}
                onClick={() => setFit((value) => !value)}
              >
                <Maximize2 className="size-4" aria-hidden />
              </Button>
            )}

            <span className="mx-1 hidden h-5 w-px bg-border sm:block" />

            {/* Desktop actions collapse into a kebab on narrow viewports. */}
            <div className="hidden items-center gap-1 sm:flex">
              {caps.reveal && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={caps.revealLabel}
                  title={caps.revealLabel}
                  onClick={onReveal}
                >
                  <FolderSearch className="size-4" aria-hidden />
                </Button>
              )}
              {caps.open && !info.executable && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={caps.openLabel}
                  title={caps.openLabel}
                  onClick={onOpenExternal}
                >
                  <ExternalLink className="size-4" aria-hidden />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label="Download"
                title="Download"
                onClick={onDownload}
              >
                <Download className="size-4" aria-hidden />
              </Button>
            </div>

            <div className="sm:hidden">
              <DropdownMenu
                align="end"
                renderTrigger={(props) => (
                  <button
                    {...props}
                    type="button"
                    aria-label="File actions"
                    className="grid size-8 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <MoreHorizontal className="size-4" aria-hidden />
                  </button>
                )}
              >
                {caps.reveal && (
                  <DropdownMenuItem onSelect={onReveal}>
                    <FolderSearch className="size-4" aria-hidden /> {caps.revealLabel}
                  </DropdownMenuItem>
                )}
                {caps.open && !info.executable && (
                  <DropdownMenuItem onSelect={onOpenExternal}>
                    <ExternalLink className="size-4" aria-hidden /> {caps.openLabel}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={onDownload}>
                  <Download className="size-4" aria-hidden /> Download
                </DropdownMenuItem>
              </DropdownMenu>
            </div>

            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Close"
              onClick={onClose}
            >
              <span aria-hidden className="text-base leading-none">
                ×
              </span>
            </Button>
          </div>
        </header>

        <div
          data-preview-scroll
          tabIndex={-1}
          className={cn(
            "min-h-0 flex-1 outline-none",
            isTextKind(info.kind) ? "overflow-auto" : "overflow-hidden",
          )}
        >
          <Body
            entry={entry}
            info={info}
            preview={preview}
            caps={caps}
            fit={fit}
            renderFailed={renderFailed}
            needsConfirm={!confirmedLoad && !withinBudget(entry)}
            onConfirm={() => setConfirmedLoad(true)}
            onRenderError={() => setRenderFailed(true)}
            onCancel={() => key && previewCache.cancel(key)}
            onDownload={onDownload}
            onOpen={caps.open && !info.executable ? onOpenExternal : undefined}
            openLabel={caps.openLabel}
            oversize={oversize}
          />
        </div>

        <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3">
          <span className="min-w-0 flex-1 select-text truncate font-mono text-[11px] text-muted-foreground">
            {relativePath}
          </span>
          <button
            type="button"
            onClick={onCopyPath}
            aria-label="Copy path"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function withinBudget(entry: HostDirEntry | null): boolean {
  if (!entry) return false;
  const size = entry.size ?? 0;
  return size <= 4 * 1024 * 1024;
}

function Body({
  entry,
  info,
  preview,
  caps,
  fit,
  renderFailed,
  needsConfirm,
  onConfirm,
  onRenderError,
  onCancel,
  onDownload,
  onOpen,
  openLabel,
  oversize,
}: {
  entry: HostDirEntry;
  info: ReturnType<typeof import("@/lib/preview/file-kinds").classifyFile>;
  preview: ReturnType<typeof usePreview>["entry"];
  caps: FileActionCapabilities;
  fit: boolean;
  renderFailed: boolean;
  needsConfirm: boolean;
  onConfirm: () => void;
  onRenderError: () => void;
  onCancel: () => void;
  onDownload: () => void;
  onOpen?: () => void;
  openLabel: string;
  oversize: number;
}) {
  const actions = <PreviewActions onDownload={onDownload} onOpen={onOpen} openLabel={openLabel} />;

  if (info.kind === "none") {
    return (
      <MetadataCard
        entry={entry}
        info={info}
        actions={actions}
        note={
          entry.kind === "symlink"
            ? "Links are not readable over this channel."
            : "There is nothing to display for this file type."
        }
      />
    );
  }

  if (needsConfirm) {
    // Above the auto-fetch budget it is the user's call, not ours: the bytes
    // travel base64 over a data channel and a silent multi-megabyte pull is a
    // surprise, not a feature.
    return (
      <MetadataCard
        entry={entry}
        info={info}
        note={`This file is ${formatSize(oversize)}. Loading it here will stream the whole thing.`}
        actions={
          <div className="flex flex-col items-center gap-2">
            <Button size="sm" onClick={onConfirm}>
              Load preview
            </Button>
            {actions}
          </div>
        }
      />
    );
  }

  if (!preview || preview.status === "loading") {
    return (
      <LoadingPreview
        received={preview?.status === "loading" ? preview.received : 0}
        total={
          preview?.status === "loading" && preview.total > 0 ? preview.total : (entry.size ?? 0)
        }
        name={entry.name}
        onCancel={onCancel}
      />
    );
  }

  if (preview.status === "error") {
    return (
      <MetadataCard
        entry={entry}
        info={info}
        actions={actions}
        note={
          previewErrorNote(preview) ??
          (caps.quicklook ? undefined : (caps.unavailableReason ?? undefined))
        }
      />
    );
  }

  if (renderFailed) {
    // A container the browser recognises can still hold a codec it cannot
    // decode; an .mkv with HEVC lands here even with a correct MIME type.
    return (
      <MetadataCard
        entry={entry}
        info={info}
        actions={actions}
        note="This browser cannot decode this file. Open it on the host instead."
      />
    );
  }

  if (info.kind === "markdown" && preview.text !== null) {
    return <MarkdownPreview text={preview.text} />;
  }

  if (isTextKind(info.kind) && preview.text !== null) {
    return (
      <div className="p-4">
        <CodeLines text={preview.text} language={info.language ?? "plain"} />
        {preview.truncated && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Showing the beginning of this file only.
          </p>
        )}
      </div>
    );
  }

  if (!preview.url) return <MetadataCard entry={entry} info={info} actions={actions} />;

  if (info.kind === "pdf") return <PdfPreview url={preview.url} name={entry.name} />;
  if (info.kind === "video" || info.kind === "audio") {
    return (
      <MediaPreview
        url={preview.url}
        mime={preview.mime}
        kind={info.kind}
        onError={onRenderError}
      />
    );
  }

  return <ImagePreview url={preview.url} alt={entry.name} fit={fit} onError={onRenderError} />;
}
