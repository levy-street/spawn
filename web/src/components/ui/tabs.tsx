"use client";

import Link from "next/link";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Two ways of being in one of several places, sharing a file because they
 * share a keyboard: arrows move along the row, Home and End jump to its ends.
 *
 * - `RouteTabs` — sections that are routes. Each tab is a link, the one you
 *   are on says so with `aria-current="page"`, and back/forward and a pasted
 *   address land on the right one. They are links in a `<nav>`, not a
 *   tablist, so every one of them is in the Tab order like any other link;
 *   the arrows are a convenience on top. Drawn on a `--shell` band with the
 *   current tab a `--background` shape cut into it: the content rises into
 *   the chrome, the grammar the workspace tab strip set (docs/DESIGN.md).
 * - `Tabs` — a pick-one switch inside a panel (`role="tablist"`), drawn as a
 *   segmented track. A composite widget: Tab enters it once, on the choice
 *   made, and selection follows the arrow keys, because every choice it
 *   offers is cheap to show.
 */

/** Which index an arrow, Home or End moves to; null for any other key. */
function step(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** One route in a `RouteTabs` band. */
export type RouteTab = {
  key: string;
  label: string;
  href: string;
  icon?: ReactNode;
  /**
   * Set when the route exists but cannot be entered right now. The tab stays
   * in its place as an inert control that carries the reason — reachable by
   * keyboard, so the reason is too — rather than disappearing and leaving the
   * row a different shape.
   */
  disabledReason?: string | null;
};

export function RouteTabs({
  label,
  tabs,
  current,
  className,
}: {
  /** What the row of routes is — "<host> sections". */
  label: string;
  tabs: readonly RouteTab[];
  /** Key of the tab whose route is showing. */
  current: string;
  className?: string;
}) {
  const reasonId = useId();
  const itemsRef = useRef<Array<HTMLElement | null>>([]);

  const onKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const next = step(event.key, index, tabs.length);
    if (next === null) return;
    event.preventDefault();
    itemsRef.current[next]?.focus();
  };

  return (
    <nav
      aria-label={label}
      className={cn(
        "flex h-11 shrink-0 items-end gap-1 overflow-x-auto bg-shell px-2 pb-1.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const active = tab.key === current;
        const shape = cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "[&>svg]:size-3.5 [&>svg]:shrink-0",
          active
            ? // The current tab continues the panel beneath it, flaring its
              // foot into it (`tab-connected`, globals.css).
              "tab-connected -mb-1.5 h-[38px] rounded-b-none bg-[var(--tab-surface)] pb-1.5 text-foreground [--tab-surface:var(--background)]"
            : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
        );
        const ref = (node: HTMLElement | null) => {
          itemsRef.current[index] = node;
        };
        if (tab.disabledReason) {
          const describedBy = `${reasonId}-${tab.key}`;
          return (
            <span key={tab.key} className="contents">
              <button
                ref={ref}
                type="button"
                aria-disabled="true"
                // Still the section on screen, though it cannot be entered.
                aria-current={active ? "page" : undefined}
                aria-describedby={describedBy}
                title={tab.disabledReason}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(shape, "cursor-not-allowed opacity-50 hover:bg-transparent")}
              >
                {tab.icon}
                {tab.label}
              </button>
              {/* Beside the control, not inside it: inside, the reason would
                  become part of the tab's name. */}
              <span id={describedBy} className="sr-only">
                {tab.disabledReason}
              </span>
            </span>
          );
        }
        return (
          <Link
            key={tab.key}
            ref={ref}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={shape}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** One choice in a `Tabs` switch. */
export type TabItem<V extends string> = {
  value: V;
  label: ReactNode;
  disabled?: boolean;
};

export function Tabs<V extends string>({
  label,
  items,
  value,
  onValueChange,
  className,
}: {
  /** What is being chosen — "Install target". */
  label: string;
  items: readonly TabItem<V>[];
  value: V | null | undefined;
  onValueChange: (value: V) => void;
  className?: string;
}) {
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.filter((item) => !item.disabled);
  const focusable = enabled.some((item) => item.value === value) ? value : enabled[0]?.value;

  const onKeyDown = (event: ReactKeyboardEvent, current: V) => {
    const index = enabled.findIndex((item) => item.value === current);
    const next = step(event.key, index, enabled.length);
    if (next === null) return;
    event.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onValueChange(target.value);
    itemsRef.current[items.indexOf(target)]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1", className)}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              itemsRef.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={item.disabled}
            tabIndex={item.value === focusable ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, item.value)}
            className={cn(
              "inline-flex h-8 flex-1 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              selected
                ? "bg-secondary text-secondary-foreground hover:bg-accent"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
