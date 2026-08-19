"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const SIDEBAR_RAIL_WIDTH = 56;

/**
 * Geometry contract that keeps collapse/expand smooth: every row is a fixed
 * `h-9` flex with a `size-9` icon slot whose left edge never moves (constant
 * `px-2.5` gutter). Only the aside width animates; labels stay mounted and
 * fade/clip, so icons hold their exact position through the transition.
 *
 * Lives here rather than in Sidebar.tsx so anything mounted *into* the rail
 * (the theme toggle) can match it without importing back from its parent.
 */
export function rowClass(active: boolean): string {
  return cn(
    "group/row flex h-9 w-full items-center rounded-lg text-sm transition-colors",
    active
      ? "bg-accent text-accent-foreground"
      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );
}

export function IconSlot({ children }: { children: ReactNode }) {
  return <span className="grid size-9 shrink-0 place-items-center">{children}</span>;
}

export function RowLabel({
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
