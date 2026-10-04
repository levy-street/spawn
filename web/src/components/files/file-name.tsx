"use client";

import { useEffect, useId, useRef, useState } from "react";
import { matchName } from "@/lib/files/filter";
import { isValidPathLeafName, type PathFlavor } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** A name with the filter's match picked out. */
export function HighlightedName({
  name,
  query,
  className,
}: {
  name: string;
  query: string;
  className?: string;
}) {
  const match = matchName(name, query);
  if (!Array.isArray(match)) return <span className={cn("truncate", className)}>{name}</span>;
  const [start, end] = match;
  return (
    <span className={cn("truncate", className)}>
      {name.slice(0, start)}
      <mark className="rounded-[2px] bg-info-soft font-semibold text-inherit">
        {name.slice(start, end)}
      </mark>
      {name.slice(end)}
    </span>
  );
}

/**
 * The inline name field for New folder, New file and Rename. Enter commits a
 * valid name; Escape or leaving the field abandons it. A rename starts with
 * the name before its extension selected, as Finder and VS Code do, so typing
 * replaces "notes" and keeps ".md".
 *
 * When the host refuses the name, `error` says why right under the field —
 * where the name was typed — and the field keeps it, focused, to be fixed or
 * abandoned. Editing the name puts the message away.
 */
export function InlineNameInput({
  initial = "",
  label,
  placeholder,
  flavor,
  pending,
  selectStem = false,
  error = null,
  onSubmit,
  onCancel,
  className,
}: {
  initial?: string;
  label: string;
  placeholder?: string;
  flavor: PathFlavor;
  pending: boolean;
  selectStem?: boolean;
  /** Why the host refused the last name submitted. */
  error?: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [draft, setDraft] = useState(initial);
  // The draft the message is about: once the name changes, it no longer is.
  const [refusedDraft, setRefusedDraft] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  useEffect(() => {
    if (!error) {
      setRefusedDraft(null);
      return;
    }
    setRefusedDraft(draftRef.current);
    ref.current?.focus();
  }, [error]);

  const shownError = error && refusedDraft === draft ? error : null;

  return (
    <span className={cn("relative z-10 flex min-w-0 flex-1", className)}>
      <input
        ref={ref}
        aria-label={label}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? errorId : undefined}
        aria-busy={pending || undefined}
        value={draft}
        placeholder={placeholder}
        // Read-only rather than disabled while the host answers, so the field
        // keeps the focus and can say why if the name is refused.
        readOnly={pending}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (pending) {
            if (event.key === "Enter") event.preventDefault();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const name = flavor === "windows" ? draft : draft.trim();
            if (isValidPathLeafName(name, flavor) && name !== initial) onSubmit(name);
            else if (name === initial) onCancel();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!pending) onCancel();
        }}
        className={cn(
          "h-5 min-w-0 flex-1 rounded border bg-background px-1 text-[13px] outline-none read-only:opacity-60",
          shownError ? "border-destructive" : "border-ring",
        )}
      />
      {shownError && (
        <span
          id={errorId}
          role="alert"
          className="absolute left-0 top-full z-30 mt-0.5 max-w-[min(28rem,100%)] whitespace-normal rounded border border-destructive bg-popover px-1.5 py-0.5 text-[11px] leading-snug text-destructive shadow-md"
        >
          {shownError}
        </span>
      )}
    </span>
  );
}
