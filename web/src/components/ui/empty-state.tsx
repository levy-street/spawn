import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Centered icon + title + body + primary action, for any surface with nothing
 * to show yet (empty workspace, no hosts, empty lists). Pass the action as a
 * ready-made `ui/button` so callers keep control of the handler and variant.
 */
export function EmptyState({
  icon,
  iconPlate = true,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  /** False renders the icon bare — for a mark that is already a plate of its
   *  own, like the brand trident. */
  iconPlate?: boolean;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {icon != null &&
        (iconPlate ? (
          <div
            className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted text-muted-foreground [&>svg]:size-6"
            aria-hidden
          >
            {icon}
          </div>
        ) : (
          icon
        ))}
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {body != null && (
          <p className="mx-auto max-w-sm text-sm leading-6 text-muted-foreground">{body}</p>
        )}
      </div>
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  );
}
