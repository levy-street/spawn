"use client";

import Link from "next/link";
import { AgentIcon } from "@/components/icons/AgentIcon";
import { SessionStatusDot } from "@/components/ui/status";
import type { Session } from "@/lib/api";
import { displayPath } from "@/lib/places";
import { sessionActivityDetail, sessionTitle } from "@/lib/sessions";

/**
 * One window on a host's page. Opening it lands on its pane in the workspace
 * tab that holds it (`sessionHref`), not on a page of its own.
 */
export function HostSessionRow({ session, href }: { session: Session; href: string }) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
      >
        <span className="relative shrink-0">
          <AgentIcon command={session.foreground_command} size={28} />
          <SessionStatusDot session={session} className="absolute -right-0.5 -bottom-0.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{sessionTitle(session)}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {displayPath(session.cwd)}
          </span>
        </span>
        <span className="hidden shrink-0 text-[11px] text-muted-foreground @md/shell:block">
          {sessionActivityDetail(session)}
        </span>
      </Link>
    </li>
  );
}
