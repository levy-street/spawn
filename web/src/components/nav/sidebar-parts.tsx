"use client";

import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/** A workspace's two-letter mark, the same in every list it appears in. */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words.length > 1
      ? `${words[0]?.[0]}${words[1]?.[0]}`
      : words[0]?.slice(0, 2)
    )?.toUpperCase() || "W"
  );
}

/**
 * The workspace's identity mark. `rail` is the larger, bordered tile the
 * collapsed sidebar navigates by; the default is the small mark that sits in
 * a row's icon slot. Archived rows wear the same one — a workspace put away
 * is still the same workspace.
 */
export function WorkspaceAvatar({
  name,
  rail = false,
  className,
}: {
  name: string;
  rail?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid place-items-center font-semibold",
        rail
          ? "size-9 rounded-lg border text-[11px] tracking-tight"
          : "size-6 rounded-md border border-border bg-muted/50 text-[10px] text-muted-foreground",
        className,
      )}
    >
      {workspaceInitials(name)}
    </span>
  );
}

/**
 * Filter-as-you-type over a sidebar list. Deliberately a filter and not a
 * command palette: it narrows the list in place, so what you are looking at
 * stays where it was.
 */
export function SidebarSearch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name — the lists are searched separately, so it must say which.
   *  Only the screen reader hears it: the box sits inside the list it filters,
   *  so on screen "Search" is already unambiguous. */
  label: string;
}) {
  return (
    <div className="relative">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        aria-label={label}
        placeholder="Search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            onChange("");
          }
        }}
        className={cn(
          // Set in the rows' own size: the box is one of them, not a caption.
          "h-8 rounded-lg border-transparent bg-muted/50 pl-8 pr-8 text-sm",
          // No ring and no border on focus: the caret and the filtered list
          // already say where you are, and an outlined box inside the sidebar
          // reads as another selected row.
          "placeholder:text-muted-foreground hover:bg-muted",
          "focus-visible:border-transparent focus-visible:bg-muted focus-visible:ring-0",
          // Safari renders its own clear affordance; ours is the one that
          // matches the rest of the chrome.
          "[&::-webkit-search-cancel-button]:appearance-none",
        )}
      />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** Shown in place of a list the search has emptied. */
export function SidebarNoMatches({ query }: { query: string }) {
  return (
    <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">Nothing matches “{query}”.</p>
  );
}
