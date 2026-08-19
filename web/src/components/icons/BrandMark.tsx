import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The spawnd trident — the mark from the landing hero, shared by the marketing
 * pages and the app chrome so both wear the same logo. Fits inside a square
 * `size-N` box (the art is portrait, so it letterboxes rather than crops).
 *
 * The art is fixed hellfire, like the third-party plates in `AgentIcon`: a
 * logo keeps its identity in both themes, and #ff4930 clears 3:1 against the
 * light and the dark ground alike.
 */
export function Trident({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block", className)}>
      <Image src="/trident.png" alt="" aria-hidden fill sizes="64px" className="object-contain" />
    </span>
  );
}

/**
 * The `spawnd` wordmark's typography — sigil mono, lowercase, wide tracking,
 * as set on the landing nav. Colour is left to the call site: app chrome uses
 * `text-brand-accent` (theme-swapped), `.grimoire` surfaces use `text-hellfire`.
 */
export const WORDMARK_CLASS = "font-sigil lowercase tracking-[0.22em]";
