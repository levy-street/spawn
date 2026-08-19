import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function sidebarRowClass(active = false): string {
  return cn(
    "group/row flex h-(--row-h) w-full items-center rounded-lg text-sm transition-colors",
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
}

export function SidebarIconSlot({ children }: { children: ReactNode }) {
  return <span className="grid size-9 shrink-0 place-items-center">{children}</span>;
}

export function SidebarRowLabel({
  collapsed,
  className,
  children,
}: {
  collapsed: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden={collapsed}
      className={cn(
        "min-w-0 flex-1 truncate whitespace-nowrap pr-1 text-left transition-opacity",
        collapsed ? "opacity-0 duration-100" : "opacity-100 delay-75 duration-150",
        className,
      )}
    >
      {children}
    </span>
  );
}
