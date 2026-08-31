"use client";

import { ChevronUp, Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LegionHostDetail } from "@/components/legion/LegionHostDetail";
import { CapacityBar, LegionDot, RunningIcons } from "@/components/legion/legion-parts";
import { SidebarIconSlot, SidebarRowLabel, sidebarRowClass } from "@/components/nav/sidebar-parts";
import { HostUpdateBadge } from "@/components/release/HostUpdateDialog";
import { useArmedMotion } from "@/components/ui/armed-motion";
import { Collapse } from "@/components/ui/collapse";
import { useHoverIntent } from "@/components/ui/hover-intent";
import type { MenuAnchor } from "@/components/ui/menu-position";
import { Popover } from "@/components/ui/popover";
import { RailTooltip } from "@/components/ui/tooltip";
import type { Host, Session } from "@/lib/api";
import {
  bucketFill,
  hostToneLabel,
  type LegionHostRow,
  STRIP_HOST_LIMIT,
  summarizeLegion,
} from "@/lib/legion";
import { cn } from "@/lib/utils";

/**
 * The legion — every machine you own — as a disclosure in the sidebar's
 * footer, dressed exactly like the Archived drawer it sits under: same row
 * class, same icon slot, same count and chevron. It is a place you keep
 * machines, not a live ticker, so it gets no chrome of its own.
 *
 * Closed, it is one row and one number. Open, each host is a name, a presence
 * dot, a session count and a two-bar capacity chart — and resting on a row
 * opens a card to the right with the spec and every session on it. Detail on
 * demand rather than five things crammed into 36px.
 *
 * Everything comes from the two queries the sidebar already polls, so the
 * section costs no request and can never disagree with the rows above it.
 * Hovering never opens a WebRTC connection; `/legion` is where exact
 * per-second figures are worth paying for.
 */

const OPEN_KEY = "spawn.sidebar.legionOpen";

/**
 * Whether the drawer is open, for the length of the tab.
 *
 * The same reason `AppShell` keeps one: this shell remounts on every route
 * change — switching workspaces included — and a component that starts closed
 * and learns better from an effect renders shut for a frame each time. Seeded
 * by the first mount's storage read; localStorage is still what survives a
 * reload.
 */
const remembered: { open: boolean | null } = { open: null };

export function LegionStrip({
  hosts,
  sessions,
  collapsed,
  onNavigate,
}: {
  hosts: Host[];
  sessions: Session[];
  /** The sidebar's own collapse — the rail, not this section's. */
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(remembered.open ?? false);
  const armed = useArmedMotion();
  const listRef = useRef<HTMLUListElement | null>(null);
  // Only where a pointer can rest. On a touch screen the card would open on
  // the tap that was meant to navigate.
  const [fineHover, setFineHover] = useState(false);
  const hover = useHoverIntent<{ hostId: string }>({ enabled: fineHover });
  const [hoverAnchor, setHoverAnchor] = useState<MenuAnchor | null>(null);

  // Only the first mount reads storage; after that `remembered` is the fresher
  // of the two — a toggle is in it before it is in localStorage's next write.
  // The mobile drawer mounts a second Sidebar, and both read the same value.
  useEffect(() => {
    if (remembered.open !== null) return;
    const stored = window.localStorage.getItem(OPEN_KEY) === "true";
    remembered.open = stored;
    setOpen(stored);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const apply = () => setFineHover(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Two rects, the same trick the file explorer's preview uses: the row gives
  // the vertical extent so the card tracks what it describes, and the sidebar
  // gives the horizontal edge so it does not slide about as the pointer runs
  // down the list.
  useLayoutEffect(() => {
    const hostId = hover.value?.hostId;
    const list = listRef.current;
    if (!hostId || !list) {
      setHoverAnchor(null);
      return;
    }
    const row = list.querySelector<HTMLElement>(`[data-legion-host="${CSS.escape(hostId)}"]`);
    if (!row) {
      setHoverAnchor(null);
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const panel = list.getBoundingClientRect();
    setHoverAnchor({
      top: rowRect.top,
      bottom: rowRect.bottom,
      left: panel.left,
      right: panel.right,
    });
  }, [hover.value]);

  const summary = summarizeLegion(hosts, sessions);
  const hoveredRow = summary.rows.find((row) => row.host.id === hover.value?.hostId) ?? null;

  const toggle = () => {
    setOpen((current) => {
      remembered.open = !current;
      window.localStorage.setItem(OPEN_KEY, String(!current));
      return !current;
    });
  };

  // Nothing to disclose and nowhere to go: onboarding owns the "connect a
  // host" moment, and a permanent row that only says "no hosts" is clutter.
  if (summary.hosts === 0) return null;

  const shown = summary.rows.slice(0, STRIP_HOST_LIMIT);
  const overflow = summary.rows.length - shown.length;

  return (
    <div className="border-t border-border px-2.5 py-2">
      <RailTooltip
        label={`Legion — ${summary.hostsOnline} of ${summary.hosts} online`}
        disabled={!collapsed}
      >
        <button
          type="button"
          // On the rail there is no room for a list, so the whole legion opens
          // where it can be read.
          onClick={
            collapsed
              ? () => {
                  onNavigate?.();
                  router.push("/legion");
                }
              : toggle
          }
          aria-label={collapsed ? `Legion (${summary.hosts})` : undefined}
          aria-expanded={collapsed ? undefined : open}
          className={cn(sidebarRowClass(false), "group/legion")}
        >
          <SidebarIconSlot>
            <Server className="size-4" aria-hidden />
          </SidebarIconSlot>
          <SidebarRowLabel collapsed={collapsed}>Legion</SidebarRowLabel>
          {!collapsed && (
            <span className="flex shrink-0 items-center gap-1.5 pr-2 text-xs tabular-nums">
              {summary.hosts}
              {/* Points up while closed — the list unfolds downward from here. */}
              <ChevronUp
                aria-hidden
                className={cn(
                  "size-3.5",
                  // Armed after the first paint: a chevron that mounts already
                  // turned must not re-spin on every workspace switch.
                  armed && "transition-transform duration-150",
                  open && "rotate-180",
                )}
              />
            </span>
          )}
        </button>
      </RailTooltip>

      {/* Mounted whether or not it is open: the drawer glides to its own
       * height, which means the rows have to exist to have a height. Collapse
       * makes the clipped content inert so a shut drawer holds nothing
       * focusable. */}
      <Collapse open={open && !collapsed}>
        <div className="space-y-1 pt-1">
          <ul ref={listRef} className="space-y-1" onPointerLeave={hover.cancel}>
            {shown.map((row) => (
              <HostRow
                key={row.host.id}
                row={row}
                onNavigate={onNavigate}
                onHover={() => hover.enter({ hostId: row.host.id })}
                onHoverEnd={hover.cancel}
              />
            ))}
          </ul>
          {overflow > 0 && (
            // Dressed as the row it sits under, pointing the way it leads.
            <Link href="/legion" onClick={onNavigate} className={sidebarRowClass(false)}>
              <SidebarIconSlot>
                <Server className="size-4 opacity-60" aria-hidden />
              </SidebarIconSlot>
              <SidebarRowLabel collapsed={false}>View all ({summary.hosts})</SidebarRowLabel>
            </Link>
          )}
        </div>
      </Collapse>

      {/* Non-interactive on purpose: the card must not be able to steal the
       * hover that opened it, and everything in it is also on the host page
       * the row navigates to. */}
      <Popover
        open={hoveredRow !== null && open && !collapsed}
        anchor={hoverAnchor}
        side="right"
        // Bottom-aligned, not top: the card is far taller than a row, so
        // hanging it from the row's top sends it down past Settings and off
        // the panel. Sharing the row's bottom edge keeps it beside the thing
        // it describes and lets it grow upward into empty sidebar.
        align="end"
        ariaLabel={hoveredRow ? `${hoveredRow.host.name} details` : undefined}
      >
        {hoveredRow && <LegionHostDetail row={hoveredRow} />}
      </Popover>
    </div>
  );
}

/**
 * One machine: name, presence, how much is on it — and, underneath, the two
 * bars that make the panel worth looking at.
 *
 * The chart is the whole reason a host row is taller than a workspace row. A
 * host that reports no capacity draws no chart and collapses back to the nav
 * rhythm, rather than showing two empty tracks — which would claim the machine
 * was idle when the truth is that it never said.
 */
function HostRow({
  row,
  onNavigate,
  onHover,
  onHoverEnd,
}: {
  row: LegionHostRow;
  onNavigate?: () => void;
  onHover?: () => void;
  onHoverEnd?: () => void;
}) {
  const charted = row.host.status === "online" && row.cpuBucket !== null;

  return (
    <li data-legion-host={row.host.id}>
      <Link
        href={`/hosts/${row.host.id}`}
        onClick={onNavigate}
        onPointerEnter={onHover}
        onFocus={onHover}
        onBlur={onHoverEnd}
        className={cn(
          // A resting ground, not just a hover one: with a chart in it a host
          // row is a card, and a card that only appears under the pointer
          // leaves the list looking like loose text between two rules. Hover
          // then steps up a shade from there rather than arriving from nothing.
          "flex flex-col justify-center gap-2.5 rounded-lg bg-accent/50 px-2 text-sm transition-colors hover:bg-accent",
          charted ? "py-2" : "h-(--row-h)",
        )}
      >
        <span className="flex items-center gap-2">
          <LegionDot tone={row.tone} label={hostToneLabel(row)} pulse={row.tone === "active"} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] leading-tight",
              row.host.status === "online" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {row.host.name}
          </span>
          <HostUpdateBadge host={row.host} />
          {/* What is on the machine, not how much: "2 Claude, 1 Codex" is the
           * thing worth knowing, and a bare 5 was never it. */}
          <RunningIcons running={row.running} fallbackCount={row.live} />
        </span>
        {/* Side by side, half the row each: the sidebar's scarce resource is
         * vertical, and two bars on one line compare directly instead of
         * making the eye travel between them. */}
        {charted && (
          <span className="flex items-center gap-1">
            <CapacityBar fill={bucketFill(row.cpuBucket)} label="CPU" className="min-w-0 flex-1" />
            <CapacityBar fill={bucketFill(row.memBucket)} label="MEM" className="min-w-0 flex-1" />
          </span>
        )}
      </Link>
    </li>
  );
}
