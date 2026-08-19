"use client";

import type { HostGpu } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "This box has a GPU", at a glance, with the detail on hover.
 *
 * Renders nothing at all when there is no GPU, when detection failed, and
 * when the daemon is too old to report one — three different situations that
 * must not be distinguishable as a broken badge.
 *
 * Vendor marks are monochrome `currentColor` glyphs sized as UI icons. These
 * are trademarks: no altered wordmarks, and anything unrecognized falls back
 * to a neutral "GPU" chip rather than a guessed logo.
 */
export function HostGpuBadge({
  gpu,
  className,
}: {
  gpu: HostGpu | null | undefined;
  className?: string;
}) {
  if (!gpu) return null;
  const extra = gpu.count > 1 ? gpu.count - 1 : 0;
  const detail = [gpu.name, formatVram(gpu.vram_mb), extra > 0 ? `${gpu.count} adapters` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      // role=img so the abbreviated visible text ("GPU 80 GB +3") is replaced
      // by the full detail for assistive tech rather than read as fragments.
      role="img"
      title={detail}
      aria-label={`GPU: ${detail}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5",
        "text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      <VendorMark vendor={gpu.vendor} />
      <span>GPU</span>
      {gpu.vram_mb ? <span className="tabular-nums">{formatVram(gpu.vram_mb)}</span> : null}
      {extra > 0 && <span className="tabular-nums">+{extra}</span>}
    </span>
  );
}

/** Whole GB above 1 GB; MB below, where rounding to 0 GB would be a lie. */
export function formatVram(vramMb: number | null | undefined): string | null {
  if (!vramMb || vramMb <= 0) return null;
  if (vramMb < 1024) return `${vramMb} MB`;
  const gb = vramMb / 1024;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

function VendorMark({ vendor }: { vendor: HostGpu["vendor"] }) {
  const className = "size-3";
  switch (vendor) {
    case "nvidia":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
          <title>NVIDIA</title>
          <path
            d="M8.9 9.3V7.9c.14 0 .28-.02.42-.02 3.9-.12 6.45 3.35 6.45 3.35s-2.76 3.83-5.72 3.83c-.4 0-.78-.06-1.15-.18v-4.3c1.5.18 1.8.85 2.71 2.36l2.02-1.7s-1.48-1.93-3.96-1.93c-.27 0-.53.02-.77.05zm0-4.55v2.06l.42-.03c5.4-.18 8.93 4.43 8.93 4.43s-4.05 4.93-8.26 4.93c-.38 0-.75-.04-1.09-.1v1.28c.29.04.6.06.9.06 3.92 0 6.76-2 9.5-4.37.46.36 2.32 1.25 2.7 1.64-2.6 2.18-8.68 3.94-12.14 3.94-.33 0-.65-.02-.96-.06v1.8H24V4.75H8.9zm0 9.9v1.09c-3.63-.65-4.64-4.42-4.64-4.42s1.74-1.93 4.64-2.24v1.19h-.01c-1.52-.18-2.71 1.24-2.71 1.24s.67 2.39 2.72 3.14zM2.5 11.17s2.15-3.17 6.4-3.5V6.53C4.2 6.9 0 10.88 0 10.88s2.38 6.87 8.9 7.49v-1.22c-4.78-.6-6.4-5.98-6.4-5.98z"
            fill="currentColor"
          />
        </svg>
      );
    case "amd":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
          <title>AMD</title>
          <path
            d="M4.9 13.4l-.7 1.7H2.9l3-6.9h1.4l3 6.9H8.9l-.7-1.7H4.9zm1.7-4l-1.2 2.9h2.4L6.6 9.4zM11 15.1V8.2h1.5l2 3.1 2-3.1h1.5v6.9h-1.3v-4.6l-1.9 2.9h-.6l-1.9-2.9v4.6H11zm8.4 0V8.2h2.4c1.5 0 2.2 1.4 2.2 3.4s-.7 3.5-2.2 3.5h-2.4zm1.3-1.2h1c.8 0 1-.9 1-2.3s-.2-2.2-1-2.2h-1v4.5z"
            fill="currentColor"
          />
        </svg>
      );
    case "intel":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
          <title>Intel</title>
          <path
            d="M2 8.2h1.5v6.9H2V8.2zm3.4 1.9h1.4v.8c.3-.6.9-.9 1.6-.9 1.2 0 1.9.8 1.9 2.1v3h-1.4v-2.7c0-.8-.3-1.2-1-1.2s-1.1.5-1.1 1.3v2.6H5.4v-5zm7.3-1.5h1.4v1.5h1.1v1.2h-1.1v2c0 .4.2.6.6.6h.5v1.2h-.8c-1.2 0-1.7-.5-1.7-1.6v-2.2h-.8v-1.2h.8V8.6zm5.4 1.4c1.4 0 2.4 1 2.4 2.6v.4h-3.5c.1.7.6 1.1 1.3 1.1.5 0 .9-.2 1.1-.6l1.1.6c-.4.8-1.2 1.2-2.2 1.2-1.6 0-2.7-1.1-2.7-2.6s1-2.7 2.5-2.7zm-1.1 2.1h2.1c-.1-.6-.5-1-1-1s-1 .4-1.1 1zM21.5 8.2H23v6.9h-1.5V8.2z"
            fill="currentColor"
          />
        </svg>
      );
    case "apple":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
          <title>Apple</title>
          <path
            d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.18-1.72-1.35-.14-2.64.79-3.33.79-.69 0-1.75-.77-2.87-.75-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.08 2.65-2.14.83-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.31-3.53zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.7-.92 2.7.97.08 1.96-.5 2.58-1.23z"
            fill="currentColor"
          />
        </svg>
      );
    default:
      // Neutral chip: better an honest blank than the wrong company's mark.
      return null;
  }
}
