"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One block of a host's page, in the shape the host panels already share
 * (approving devices, agent availability): a hairline card with its title in
 * a header row and an optional action at the end of it.
 */
export function CockpitSection({
  id,
  title,
  count,
  action,
  className,
  children,
}: {
  /** Prefix for the heading's id; the section is labelled by it. */
  id: string;
  title: string;
  count?: number;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section
      className={cn("overflow-hidden rounded-xl border border-border", className)}
      aria-labelledby={headingId}
    >
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 id={headingId} className="text-sm font-medium">
          {title}
          {count !== undefined && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A labelled fact: a mono caps caption over its value. */
export function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  const title = typeof value === "string" ? value : undefined;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("mt-0.5 truncate", mono && "font-mono text-xs leading-5")} title={title}>
        {value}
      </dd>
    </div>
  );
}
