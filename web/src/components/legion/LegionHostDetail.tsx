"use client";
import { CapacityBar, LegionDot } from "@/components/legion/legion-parts";
import { SessionStatusDot } from "@/components/ui/status";
import { hostHealthPanel } from "@/lib/host-health";
import type { LegionHostRow } from "@/lib/legion";
import { bucketFill, capacityLabel, specLine } from "@/lib/legion";
import { relativeTime, sessionActivityLabel, sessionTitle } from "@/lib/sessions";

/**
 * Everything about one machine, in a card that opens when you rest on its row.
 *
 * This is the other half of the strip's bargain: the row is allowed to be
 * almost nothing — a dot, a name, a count — precisely because the detail is one
 * hover away. Capacity, spec, and every session with what it is doing live
 * here, where there is room to lay them out instead of compressing them into a
 * 36px sidebar row.
 *
 * It shows the heartbeat's coarse reading rather than opening a direct channel
 * for exact figures: a hover must not cost a WebRTC connection. `/legion` is
 * where you go to pay for that.
 *
 * Read-only, with nothing to click. The card is a `role="tooltip"` with pointer
 * events off so it cannot steal the hover that opened it, which means any
 * control in here would be unreachable — and unnecessary, since the row it
 * describes is itself the link to that host's page.
 */

/** Sessions listed before the card defers to the host page. */
const SESSION_LIMIT = 6;

export function LegionHostDetail({ row }: { row: LegionHostRow }) {
  const host = row.host;
  const online = host.status === "online";
  const spec = specLine(host);
  const shown = row.sessions.slice(0, SESSION_LIMIT);
  const overflow = row.sessions.length - shown.length;
  const health = hostHealthPanel(host);

  return (
    <div className="w-64 max-w-[min(18rem,calc(100vw-2rem))] p-3 text-sm">
      <header className="flex items-center gap-2">
        <LegionDot tone={row.tone} label={row.tone} />
        <span className="min-w-0 flex-1 truncate font-medium">{host.name}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          {online ? "online" : "offline"}
        </span>
      </header>

      {(spec || host.cpu_model) && (
        <p className="mt-1.5 font-mono text-[10.5px] leading-4 text-muted-foreground">
          {[host.os, spec].filter(Boolean).join(" · ")}
          {host.cpu_model && (
            <>
              <br />
              {host.cpu_model}
            </>
          )}
        </p>
      )}

      {online && (row.cpuBucket !== null || row.memBucket !== null) && (
        <div className="mt-2.5 flex flex-col gap-2 border-t border-popover-border pt-2.5">
          <Reading label="CPU" value={row.cpuBucket} />
          <Reading label="MEM" value={row.memBucket} />
        </div>
      )}

      {!online && (
        <div className="mt-2.5 space-y-1 border-t border-popover-border pt-2.5">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground">
            Something wrong?
          </p>
          <p className="text-xs leading-4 text-muted-foreground">{health.message}</p>
        </div>
      )}

      <div className="mt-2.5 border-t border-popover-border pt-2.5">
        {row.sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {online ? "Nothing running here." : "This machine is offline."}
          </p>
        ) : (
          <>
            <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground">
              {row.sessions.length} {row.sessions.length === 1 ? "session" : "sessions"}
            </p>
            <ul className="space-y-1">
              {shown.map((session) => (
                <li key={session.id} className="flex items-center gap-2">
                  {/* The app's own status dot rather than a private copy of
                   * its tone map: a waiting session must look the same here as
                   * it does on a pane header. */}
                  <SessionStatusDot session={session} className="size-1.5 border-0" />
                  <span className="min-w-0 flex-1 truncate text-xs">{sessionTitle(session)}</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
                    {relativeTime(session.last_activity_at) ?? sessionActivityLabel(session)}
                  </span>
                </li>
              ))}
            </ul>
            {overflow > 0 && (
              <p className="mt-1 text-[10.5px] text-muted-foreground">+{overflow} more</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A bucket as a bar plus a word. The word is the clarity: a five-level reading
 * rendered as "60%" would be a number the server was deliberately never given,
 * and "Busy" is what a person wanted to know anyway.
 */
function Reading({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <CapacityBar
      label={label}
      size="md"
      fill={bucketFill(value)}
      caption={capacityLabel(value) ?? undefined}
    />
  );
}
