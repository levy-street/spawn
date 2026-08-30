"use client";

import { Download, ExternalLink, Loader2 } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from "react";
import { formatSize } from "@/components/files/FileExplorer";
import { FileIcon } from "@/components/files/file-icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { HostDirEntry } from "@/lib/hostControl";
import { tokenizeCode } from "@/lib/preview/code-tokenize";
import type { CodeLanguage, FileTypeInfo } from "@/lib/preview/file-kinds";
import type { PreviewEntry } from "@/lib/preview/preview-cache";
import { cn } from "@/lib/utils";

/** Transparency checkerboard, built from tokens so it swaps with the theme. */
const CHECKERBOARD =
  "bg-[repeating-conic-gradient(var(--muted)_0%_25%,var(--card)_0%_50%)] bg-[length:16px_16px]";

const TOKEN_CLASS: Record<string, string> = {
  comment: "text-code-comment italic",
  string: "text-code-string",
  keyword: "text-code-keyword",
  number: "text-code-number",
  punct: "text-code-punct",
  tag: "text-code-keyword",
  attr: "text-code-number",
  plain: "",
};

export function CodeLines({
  text,
  language,
  maxLines,
  showLineNumbers = true,
  className,
}: {
  text: string;
  language: CodeLanguage;
  maxLines?: number;
  showLineNumbers?: boolean;
  className?: string;
}) {
  const lines = useMemo(
    () => tokenizeCode(text, language, maxLines ? { maxLines } : undefined),
    [text, language, maxLines],
  );
  return (
    <pre
      className={cn(
        "w-max min-w-full font-mono text-[11px] leading-[1.55] text-foreground",
        className,
      )}
    >
      <code>
        {lines.map((tokens, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            key={index}
            className="flex"
          >
            {showLineNumbers && (
              <span
                aria-hidden
                className="sticky left-0 mr-3 w-10 shrink-0 select-none bg-inherit pr-2 text-right tabular-nums text-muted-foreground/60"
              >
                {index + 1}
              </span>
            )}
            <span className="whitespace-pre">
              {tokens.length === 0 ? " " : null}
              {tokens.map((token, tokenIndex) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                  key={tokenIndex}
                  className={TOKEN_CLASS[token.kind] ?? ""}
                >
                  {token.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </code>
    </pre>
  );
}

export function LoadingPreview({
  received,
  total,
  name,
  onCancel,
}: {
  received: number;
  total: number;
  name?: string;
  onCancel?: () => void;
}) {
  const determinate = total > 0;
  const percent = determinate ? Math.min(100, Math.round((received / total) * 100)) : 0;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6">
      <div className="flex w-52 max-w-full flex-col items-center gap-2.5">
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        {name && (
          <p className="max-w-full truncate text-[12px] font-medium text-foreground">{name}</p>
        )}
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
          {...(determinate
            ? {
                role: "progressbar",
                "aria-valuenow": percent,
                "aria-valuemin": 0,
                "aria-valuemax": 100,
              }
            : { role: "progressbar", "aria-busy": true })}
        >
          <div
            className={cn(
              "h-full rounded-full bg-foreground/45",
              // Without a declared length there is nothing honest to show as a
              // proportion, so the bar paces itself instead of pretending.
              determinate ? "transition-[width] duration-200 ease-out" : "w-1/3 animate-pulse",
            )}
            style={determinate ? { width: `${percent}%` } : undefined}
          />
        </div>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {determinate ? `${formatSize(received)} of ${formatSize(total)}` : "Loading…"}
        </p>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The universal fallback: what we know about the file, and the two things the
 * host can still do with it. Reached by symlinks, archives, binaries, oversized
 * media, codec failures, and any format this host has no renderer for.
 */
export function MetadataCard({
  entry,
  info,
  note,
  actions,
  compact = false,
}: {
  entry: Pick<HostDirEntry, "name" | "size" | "kind">;
  info: FileTypeInfo;
  note?: string;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-2 text-center",
        compact ? "p-4" : "p-8",
      )}
    >
      <div className="grid size-12 place-items-center rounded-lg bg-muted">
        <FileIcon name={entry.name} kind={entry.kind} className="size-6 text-muted-foreground" />
      </div>
      <p className="text-[13px] font-medium text-foreground">{info.label}</p>
      {entry.size != null && (
        <p className="text-[11px] tabular-nums text-muted-foreground">{formatSize(entry.size)}</p>
      )}
      {note && <p className="max-w-64 text-[11px] text-muted-foreground">{note}</p>}
      {actions && <div className="mt-2">{actions}</div>}
    </div>
  );
}

export function ImagePreview({
  url,
  alt,
  fit,
  className,
  onError,
}: {
  url: string;
  alt: string;
  fit: boolean;
  className?: string;
  onError?: () => void;
}) {
  return (
    <div className={cn("grid h-full w-full place-items-center overflow-auto", CHECKERBOARD)}>
      {/* biome-ignore lint/performance/noImgElement: a blob URL, not a remote asset */}
      <img
        src={url}
        alt={alt}
        onError={onError}
        className={cn(fit ? "max-h-full max-w-full object-contain" : "max-w-none", className)}
      />
    </div>
  );
}

export function PdfPreview({ url, name }: { url: string; name: string }) {
  return (
    <embed
      src={url}
      type="application/pdf"
      title={name}
      className="size-full bg-muted"
      aria-label={`${name} preview`}
    />
  );
}

export function MediaPreview({
  url,
  mime,
  kind,
  poster,
  onError,
}: {
  url: string;
  mime: string;
  kind: "video" | "audio";
  poster?: string;
  onError?: () => void;
}) {
  if (kind === "audio") {
    return (
      <div className="grid h-full w-full place-items-center p-8">
        {/* biome-ignore lint/a11y/useMediaCaption: user media, no track available */}
        <audio controls src={url} onError={onError} className="w-full max-w-md">
          <source src={url} type={mime} />
        </audio>
      </div>
    );
  }
  return (
    <div className="grid h-full w-full place-items-center bg-black/40">
      {/* biome-ignore lint/a11y/useMediaCaption: user media, no track available */}
      <video
        controls
        playsInline
        poster={poster}
        onError={onError}
        className="max-h-full max-w-full"
      >
        <source src={url} type={mime} />
      </video>
    </div>
  );
}

/**
 * Markdown, rendered lazily.
 *
 * `react-markdown` builds a React element tree and never produces an HTML
 * string, so there is no `dangerouslySetInnerHTML` anywhere in this path — the
 * usual `marked` + sanitiser shape stakes everything on the sanitiser being
 * right, and file content is fully untrusted. `rehype-raw` must never be added
 * here: it would reopen exactly the hole this choice closes.
 */
export function MarkdownPreview({ text, compact = false }: { text: string; compact?: boolean }) {
  const [loaded, setLoaded] = useState<{
    Markdown: ComponentType<Record<string, unknown>>;
    gfm: unknown;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [markdown, gfm] = await Promise.all([import("react-markdown"), import("remark-gfm")]);
        if (!live) return;
        setLoaded({
          Markdown: markdown.default as ComponentType<Record<string, unknown>>,
          gfm: gfm.default,
        });
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (failed) return <CodeLines text={text} language="markdown" showLineNumbers={!compact} />;
  if (!loaded) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    );
  }

  const { Markdown, gfm } = loaded;
  return (
    <div
      className={cn(
        "prose-preview leading-relaxed text-foreground",
        // The hover card is half the dialog's width and a third of its height,
        // so the same margins would leave it showing a paragraph and a half.
        compact ? "px-4 py-3 text-[12px]" : "px-6 py-5 text-[13px]",
      )}
    >
      <Markdown
        remarkPlugins={[gfm]}
        // Only schemes that cannot execute. This is what stops
        // `[click](javascript:...)` and `data:` payloads in a previewed file.
        urlTransform={(url: string) => (/^(https?:|mailto:)/i.test(url) ? url : "")}
        components={{
          a: (props: Record<string, unknown>) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            />
          ),
          // Relative images would fire a request the browser cannot satisfy;
          // name the file instead of showing a broken frame.
          img: (props: Record<string, unknown>) => (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              image ·{" "}
              {String((props as { alt?: string }).alt || (props as { src?: string }).src || "")}
            </span>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function PreviewActions({
  onDownload,
  onOpen,
  openLabel,
}: {
  onDownload?: () => void;
  onOpen?: () => void;
  openLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {onOpen && openLabel && (
        <Button size="sm" variant="secondary" onClick={onOpen}>
          <ExternalLink className="size-4" aria-hidden />
          {openLabel}
        </Button>
      )}
      {onDownload && (
        <Button size="sm" variant="ghost" onClick={onDownload}>
          <Download className="size-4" aria-hidden />
          Download
        </Button>
      )}
    </div>
  );
}

/** Human sentence for a failed preview. */
export function previewErrorNote(entry: PreviewEntry | undefined): string | undefined {
  if (!entry || entry.status !== "error") return undefined;
  switch (entry.code) {
    case "preview_unsupported":
      return "This host cannot render a preview for this file.";
    case "preview_unavailable":
      return "The host has no preview generator for this file type.";
    case "preview_timeout":
      return "The host took too long to render this file. Try opening it there instead.";
    case "preview_too_large":
    case "too_large":
      return "This file is too large to preview here.";
    case "not_text":
      return "This file is not text.";
    case "symlink_rejected":
      return "Links are not readable over this channel.";
    default:
      return entry.message;
  }
}
