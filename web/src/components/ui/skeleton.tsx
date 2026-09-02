import { cn } from "@/lib/utils";

/**
 * A placeholder tinted from the foreground rather than from `--muted`: the
 * muted ground is darker than a popover in the dark theme, so a skeleton
 * painted with it disappears into any menu or picker it loads inside — the
 * folder picker read as an empty box for the whole of a slow listing. A
 * fraction of the text colour reads on every surface the app draws.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-foreground/8", className)} />;
}
