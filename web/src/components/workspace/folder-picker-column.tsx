"use client";

import { ChevronRight, Folder } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** One rung of the picker's column trail. */
export type FolderColumnEntry = { name: string; path: string };

/**
 * What a column shows in place of a list. Every reason a column comes up empty
 * has a different way out — create a folder, clear the filter, reveal the
 * hidden ones — so the caller supplies the way out along with the wording.
 */
export type FolderColumnEmpty = {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
};

/**
 * A single Finder column: the subfolders of one directory, with the child the
 * trail continues through highlighted. Selecting a row does not replace the
 * list — the picker appends the selection's own column to the right of this
 * one, so the path you walked stays on screen beside where you landed.
 */
export function FolderColumn({
  folderPath,
  entries,
  selectedPath,
  pending,
  errorMessage,
  empty,
  truncated,
  selectedRef,
  onSelect,
  onKeyDown,
  first,
  tabIndex,
  columnRef,
}: {
  folderPath: string;
  entries: readonly FolderColumnEntry[];
  /** The row drawn as selected, or null for the trailing column. */
  selectedPath: string | null;
  pending: boolean;
  errorMessage: string | null;
  empty: FolderColumnEmpty;
  /** The daemon stopped short of the end of this directory. */
  truncated: boolean;
  /** Attached to the selected row so the picker can scroll it into view. */
  selectedRef?: Ref<HTMLButtonElement>;
  onSelect: (path: string) => void;
  /** Trail-wide arrow navigation; row buttons bubble their keys up to here. */
  onKeyDown: (event: ReactKeyboardEvent) => void;
  first: boolean;
  /** 0 on the trailing column only: one tab stop for the whole browser. */
  tabIndex: number;
  /** Attached to the trailing column so the picker can focus it on open. */
  columnRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={columnRef}
      role="listbox"
      aria-label={`Folders in ${folderPath}`}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      className={cn(
        // Share the strip evenly rather than sitting at a fixed width with
        // dead space beside them: `flex-1` splits whatever room there is, and
        // --picker-column (set by the panel) is the floor at which they stop
        // giving ground and the strip starts scrolling instead. The panel is
        // two columns wide, so a third pushes the first out of frame.
        "flex min-w-(--picker-column) flex-1 flex-col overflow-y-auto overscroll-y-contain p-1",
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        !first && "border-l border-border",
      )}
    >
      {pending ? (
        <div className="space-y-1 p-1">
          {["one", "two", "three", "four", "five"].map((key) => (
            <Skeleton key={key} className="h-8 w-full" />
          ))}
        </div>
      ) : errorMessage !== null ? (
        <p className="px-2 py-3 text-xs leading-5 text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={empty.icon}
          title={empty.title}
          body={empty.body}
          action={empty.action}
          className="m-auto gap-2.5 px-3 py-6"
        />
      ) : (
        <>
          {entries.map((entry) => {
            const selected = entry.path === selectedPath;
            return (
              <button
                key={entry.path}
                ref={selected ? selectedRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(entry.path)}
                className={cn(
                  "flex h-9 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {/* On every row, not just the selected one: the chevron is what
                    says a click opens another column rather than ending here. */}
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground",
                    selected ? "opacity-100" : "opacity-45",
                  )}
                  aria-hidden
                />
              </button>
            );
          })}
          {/* The daemon refuses to inventory past its own ceiling, so say so
              rather than letting a clipped list read as the whole folder. */}
          {truncated && (
            <p className="px-2 py-2 text-[11px] leading-4 text-muted-foreground">
              Too many items to list them all — use the filter to narrow this folder.
            </p>
          )}
        </>
      )}
    </div>
  );
}
