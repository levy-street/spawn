"use client";

import { ChevronRight, House } from "lucide-react";
import { forwardRef, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { GO_TO_FOLDER_LABEL } from "@/lib/files/copy";
import { displayPath } from "@/lib/files/navigation";
import {
  isPathWithin,
  joinPath,
  normalizeAbsolutePath,
  type PathFlavor,
  basename as pathBasename,
  pathsEqual,
  trimTrailingSlash,
} from "@/lib/paths";
import { cn } from "@/lib/utils";

export type PathBarHandle = { edit: () => void };

/**
 * Where the browser is: crumbs from the top of what it may show (home on the
 * hosts page, the pane's folder in a workspace) down to the current folder.
 * Clicking the bar's empty space — or ⇧⌘G / Ctrl+Shift+G — turns it into a
 * "Go to folder" field that takes `~/…`, an absolute path inside home, or a
 * path relative to the current folder; the host's refusal is said under it.
 */
export const PathBar = forwardRef<
  PathBarHandle,
  {
    path: string;
    /** The highest crumb; nothing above it is offered. */
    ceiling: string;
    ceilingLabel: string;
    homeDir: string;
    flavor: PathFlavor;
    editable: boolean;
    onNavigate: (path: string) => void;
    /** Resolve and go; returns what to say when it cannot, or null on success. */
    onSubmit?: (input: string) => Promise<string | null>;
    className?: string;
  }
>(function PathBar(
  { path, ceiling, ceilingLabel, homeDir, flavor, editable, onNavigate, onSubmit, className },
  ref,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const crumbs = useMemo(() => {
    const top = trimTrailingSlash(normalizeAbsolutePath(ceiling, flavor), flavor);
    const out = [{ label: ceilingLabel, path: top }];
    if (!isPathWithin(path, top, flavor) || pathsEqual(path, top, flavor)) return out;
    const rest = trimTrailingSlash(normalizeAbsolutePath(path, flavor), flavor)
      .slice(top.length)
      .split(flavor === "windows" ? /[\\/]/u : "/")
      .filter(Boolean);
    let current = top;
    for (const part of rest) {
      current = normalizeAbsolutePath(joinPath(current, part, flavor), flavor);
      out.push({ label: part, path: current });
    }
    return out;
  }, [ceiling, ceilingLabel, flavor, path]);

  const startEditing = () => {
    if (!editable || !onSubmit) return;
    setDraft(displayPath(path, homeDir, flavor));
    setError(null);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  useImperativeHandle(ref, () => ({ edit: startEditing }));

  const submit = async () => {
    if (!onSubmit || pending) return;
    setPending(true);
    try {
      const problem = await onSubmit(draft);
      if (problem) setError(problem);
      else {
        setEditing(false);
        setError(null);
      }
    } finally {
      setPending(false);
    }
  };

  if (editing) {
    return (
      <div className={cn("min-w-0", className)}>
        <input
          ref={inputRef}
          aria-label={GO_TO_FOLDER_LABEL}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          value={draft}
          disabled={pending}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
              setError(null);
            }
          }}
          onBlur={() => {
            if (!pending && error === null) setEditing(false);
          }}
          className={cn(
            "h-8 w-full rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
            error ? "border-destructive" : "border-input",
          )}
        />
        {error && (
          <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <nav
      aria-label="Folder path"
      className={cn(
        "flex h-8 min-w-0 items-center rounded-md border border-transparent px-1",
        editable && onSubmit && "cursor-text hover:border-input",
        className,
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) startEditing();
      }}
    >
      <ol className="flex min-w-0 items-center">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li
              key={crumb.path}
              className={cn("flex min-w-0 items-center", last ? "shrink" : "shrink-[4]")}
            >
              {index > 0 && (
                <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              )}
              <button
                type="button"
                aria-current={last ? "page" : undefined}
                title={displayPath(crumb.path, homeDir, flavor)}
                onClick={() => onNavigate(crumb.path)}
                className={cn(
                  "flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors hover:bg-accent",
                  last ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {index === 0 && pathsEqual(crumb.path, homeDir, flavor) && (
                  <House aria-hidden className="size-3.5 shrink-0" />
                )}
                <span className="truncate">
                  {index === 0 ? crumb.label : pathBasename(crumb.path, flavor) || crumb.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {editable && onSubmit && (
        <button
          type="button"
          aria-label={GO_TO_FOLDER_LABEL}
          title={`${GO_TO_FOLDER_LABEL}…`}
          onClick={startEditing}
          className="ml-auto h-full min-w-6 flex-1 cursor-text"
        />
      )}
    </nav>
  );
});
