import { cn } from "@/lib/utils";

/**
 * A progress track: a number (0–100) where something real is being counted,
 * `"indeterminate"` where it is honestly only "still going" — a stripe that
 * travels the track without claiming a position. A number is clamped, so a
 * total that turns out smaller than what arrived never paints outside the
 * track. Reduced motion keeps the stripe still and half-filled; the text
 * beside it carries the meaning (DESIGN.md rule 6).
 */
export function ProgressBar({
  value,
  label,
  tone = "primary",
  className,
}: {
  value: number | "indeterminate";
  /** What it measures, for a screen reader: "Uploading notes.md". */
  label?: string;
  /** `warning` for work that has stopped and is waiting on someone. */
  tone?: "primary" | "warning";
  className?: string;
}) {
  const determinate = typeof value === "number";
  const percent = determinate ? Math.max(0, Math.min(100, Math.round(value))) : undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={percent}
      aria-valuetext={determinate ? `${percent}%` : "in progress"}
      className={cn("relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted", className)}
    >
      {determinate ? (
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300 ease-swift",
            tone === "warning" ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      ) : (
        <div
          className={cn(
            "h-full w-1/3 rounded-full motion-safe:animate-toast-progress motion-reduce:w-1/2",
            tone === "warning" ? "bg-warning" : "bg-primary",
          )}
        />
      )}
    </div>
  );
}
