"use client";

import { Loader2, Maximize2 } from "lucide-react";
import { formatSize } from "@/components/files/FileExplorer";
import { FileIcon } from "@/components/files/file-icon";
import { PREVIEW_CARD_WIDTH_PX } from "@/components/files/preview-placement";
import {
  CodeLines,
  ImagePreview,
  MarkdownPreview,
  MetadataCard,
  previewErrorNote,
} from "@/components/files/preview-renderers";
import { usePreview } from "@/components/files/use-preview";
import type { HostControlClient, HostDirEntry } from "@/lib/hostControl";
import type { FileActionCapabilities } from "@/lib/preview/capabilities";
import { isTextKind } from "@/lib/preview/file-kinds";
import { cn } from "@/lib/utils";

/**
 * The hover preview.
 *
 * Fixed width, capped height, and no pointer events — it must not be able to
 * capture the hover that opened it, cover the row's kebab, or swallow a click.
 * The cost is that nothing inside can be scrolled or selected, which is exactly
 * the line between this and the viewer dialog.
 */
export function FilePreviewCard({
  hostId,
  entry,
  client,
  caps,
  onOpen,
}: {
  hostId: string;
  entry: HostDirEntry;
  client: HostControlClient | null;
  caps: FileActionCapabilities;
  onOpen: () => void;
}) {
  const { entry: preview, info } = usePreview({
    client,
    hostId,
    entry,
    variant: "thumb",
    caps,
  });

  if (!info) return null;

  const relativeTime = formatWhen(entry.modified_at);

  return (
    // Width from the constant the explorer measures its panel against, so the
    // two cannot drift; `max-w-full` is what lets the popover's own cap shrink
    // the card when it is lying over a panel that has less room than that.
    <div style={{ width: PREVIEW_CARD_WIDTH_PX }} className="max-w-full">
      <div className="flex items-center gap-2 border-b border-popover-border px-3 py-2">
        <FileIcon
          name={entry.name}
          kind={entry.kind}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{entry.name}</span>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${entry.name}`}
          title="Open"
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-popover-accent hover:text-foreground"
        >
          <Maximize2 className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* Scrollable, so a long file can be read here rather than only opened.
          `overscroll-contain` keeps a wheel at the end of the card from
          scrolling the file tree underneath it. */}
      <div className="max-h-[28rem] min-h-32 overflow-auto overscroll-contain">
        <PreviewBody entry={entry} info={info} preview={preview} caps={caps} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-popover-border px-3 py-1.5 text-[10px] tabular-nums text-muted-foreground">
        <span>{entry.size == null ? "—" : formatSize(entry.size)}</span>
        {relativeTime && <span>{relativeTime}</span>}
      </div>
    </div>
  );
}

function PreviewBody({
  entry,
  info,
  preview,
  caps,
}: {
  entry: HostDirEntry;
  info: ReturnType<typeof import("@/lib/preview/file-kinds").classifyFile>;
  preview: ReturnType<typeof usePreview>["entry"];
  caps: FileActionCapabilities;
}) {
  if (info.kind === "none") {
    return (
      <MetadataCard
        entry={entry}
        info={info}
        compact
        note={entry.kind === "symlink" ? "Links are not readable over this channel." : undefined}
      />
    );
  }

  if (!preview || preview.status === "loading") {
    // Rendering on the host runs a real subprocess and can take a moment, so it
    // says so. Skeleton lines would read as a file that loaded blank.
    if (info.kind === "quicklook") {
      return (
        <div className="flex w-full flex-col items-center justify-center gap-2 p-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-[11px] text-muted-foreground">Rendering on the host…</p>
        </div>
      );
    }
    // `Skeleton` is tuned for --card, which is *darker* than --popover; on this
    // surface it disappears and the card reads as blank. Placeholder lines here
    // rise off the popover instead, the way its own accent does.
    return (
      <div
        role="status"
        aria-label="Loading preview"
        aria-busy
        className="w-full animate-pulse space-y-2 p-4"
      >
        {["w-2/3", "w-full", "w-11/12", "w-5/6", "w-1/2"].map((width) => (
          <div key={width} className={cn("h-2.5 rounded bg-popover-accent", width)} />
        ))}
      </div>
    );
  }

  if (preview.status === "error") {
    return (
      <MetadataCard
        entry={entry}
        info={info}
        compact
        note={
          previewErrorNote(preview) ??
          (caps.quicklook ? undefined : (caps.unavailableReason ?? undefined))
        }
      />
    );
  }

  // Set the same way the viewer sets it. A glance at a README is a glance at
  // the document, not at its punctuation — and a card that showed the source
  // where the dialog one keystroke later shows headings and lists reads as two
  // different files. Everything heavier stays the viewer's: this card renders
  // a poster where the dialog runs a player.
  if (info.kind === "markdown" && preview.text !== null) {
    return <MarkdownPreview text={preview.text} compact />;
  }

  if (isTextKind(info.kind) && preview.text !== null) {
    return (
      <div className="w-max min-w-full px-3 py-2">
        <CodeLines
          text={preview.text}
          language={info.language ?? "plain"}
          showLineNumbers={false}
        />
      </div>
    );
  }

  if (preview.url) {
    // Everything visual is shown as an image here, including host-rendered
    // documents and video posters — the card is a glance, not a player.
    return (
      <div className="grid min-h-40 place-items-center p-2">
        <ImagePreview url={preview.url} alt={entry.name} fit className="max-h-[26rem]" />
      </div>
    );
  }

  return <MetadataCard entry={entry} info={info} compact />;
}

function formatWhen(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86_400 * 30) return `${Math.floor(delta / 86_400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}
