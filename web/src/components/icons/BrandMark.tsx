import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The spawnd trident — the ink-blob mark from the brand kit, shared by the
 * marketing pages and the app chrome so both wear the same logo. Fits inside a
 * square `size-N` box (the art is square, drawn as merged wet-ink droplets).
 *
 * The art is fixed brand red, like the third-party plates in `AgentIcon`: a
 * logo keeps its identity in both themes, and #E11E15 clears 3:1 against the
 * light and the dark ground alike.
 */
export function Trident({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block", className)}>
      <Image
        src="/brand/spawnd-icon.svg"
        alt=""
        aria-hidden
        fill
        sizes="64px"
        className="object-contain"
      />
    </span>
  );
}

const WORDMARK_MASK: React.CSSProperties = {
  WebkitMaskImage: "url(/brand/spawnd-wordmark.svg)",
  maskImage: "url(/brand/spawnd-wordmark.svg)",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskSize: "contain",
  maskSize: "contain",
  WebkitMaskPosition: "left center",
  maskPosition: "left center",
};

/**
 * The drawn `spawnd` wordmark from the brand kit — blocky letterforms built
 * from the same merged ink droplets as the trident. Same art as the brand
 * kit's `spawnd-text-red`, left unpainted so it renders as a CSS mask filled
 * with `currentColor` — call sites colour it exactly like text. Pair it with
 * the trident under `text-hellfire`: that is the brand ink (#E11E15) the
 * trident art is drawn in, so the lockup reads as one mark. The chrome's
 * `--brand-accent` is not it — dark swaps that to ember and splits the pair.
 *
 * Size it by height (`h-3.5`, `h-[19px]`…); the width follows from the
 * lockup's fixed 1753:370 aspect ratio.
 */
export function Wordmark({
  className,
  "aria-hidden": ariaHidden,
}: {
  className?: string;
  "aria-hidden"?: boolean;
}) {
  const classes = cn("inline-block aspect-[1753/370] shrink-0 bg-current", className);
  if (ariaHidden) {
    return <span aria-hidden className={classes} style={WORDMARK_MASK} />;
  }
  return <span role="img" aria-label="SPAWN D" className={classes} style={WORDMARK_MASK} />;
}
