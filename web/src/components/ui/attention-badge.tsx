import { cn } from "@/lib/utils";
import type { AttentionLevel } from "@/lib/workspaces";

/**
 * How many windows behind something want you, toned by the most urgent: red
 * when one has died, amber when one is waiting. A soft pill rather than a
 * solid one, so a sidebar full of them reads as a quiet margin of signal,
 * not a column of alarms. The phone uses the same rule (tab-attention-badge).
 */
export function AttentionBadge({
  count,
  level,
  className,
}: {
  count: number;
  level: AttentionLevel | null;
  className?: string;
}) {
  if (count <= 0 || level === null) return null;
  const label =
    level === "dead"
      ? `${count} ${count === 1 ? "window has" : "windows have"} stopped or need you`
      : `${count} ${count === 1 ? "window is" : "windows are"} waiting on you`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1.5",
        "font-mono text-[10px] font-semibold tabular-nums leading-none",
        level === "dead" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
