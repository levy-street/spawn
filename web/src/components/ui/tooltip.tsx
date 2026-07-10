import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * CSS-only hover tooltip used by the collapsed sidebar rail. Appears to the
 * right after a short delay, like ChatGPT's rail tooltips. Render with
 * `disabled` when the sidebar is expanded so no tooltip markup exists.
 */
export function RailTooltip({
  label,
  disabled = false,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (disabled) return <>{children}</>;
  return (
    <div className={cn("group/tt relative", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-full top-1/2 z-[60] ml-2 -translate-y-1/2",
          "whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
          "opacity-0 transition-opacity duration-100 group-hover/tt:opacity-100 group-hover/tt:delay-500 group-focus-within/tt:opacity-100",
        )}
      >
        {label}
      </span>
    </div>
  );
}
