"use client";

import type { ReactNode } from "react";
import { AgentIcon, agentDisplayName } from "@/components/icons/AgentIcon";
import { fillTone } from "@/lib/legion";
import { cn } from "@/lib/utils";

/**
 * The legion's shared instrument set: a capacity bar, a presence dot, the marks
 * for what is running. Every legion surface draws the same ones, so a host that
 * looks pinned in the sidebar looks pinned on the page it opens.
 */

/** Distinct agent marks a row shows before the rest become a count. */
const MAX_AGENT_MARKS = 3;

/** The load ramp, in the app's own status tones. */
const FILL_TONE: Record<ReturnType<typeof fillTone>, string> = {
  free: "bg-tone-active",
  tight: "bg-warning",
  full: "bg-destructive",
};

/**
 * A capacity reading as a track that fills — CPU, memory, anything scalar.
 *
 * Continuous rather than the segmented block it replaces: five little squares
 * read as a widget, a filled track reads as a chart, and a chart is what a
 * fleet panel is for. It takes a fraction rather than a bucket or a percentage
 * so the same bar draws the heartbeat's coarse reading (`bucket / 5`) and the
 * exact figure a direct channel returns (`percent / 100`) without either
 * pretending to be the other.
 */
export function CapacityBar({
  fill,
  label,
  caption,
  size = "sm",
  className,
}: {
  /** 0..1. Anything outside is clamped; NaN draws an empty track. */
  fill: number;
  /** Short legend — "CPU", "MEM". Also the accessible name. */
  label: string;
  /** Right-hand reading: "41%", "Busy". Omitted where the bar speaks alone. */
  caption?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const clamped = Number.isFinite(fill) ? Math.max(0, Math.min(1, fill)) : 0;
  return (
    <span
      className={cn(
        "relative flex w-full items-center overflow-hidden rounded-sm bg-muted-foreground/15",
        size === "sm" ? "h-4" : "h-5",
        className,
      )}
      role="img"
      aria-label={`${label}: ${caption ?? `${Math.round(clamped * 100)}%`}`}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 transition-[width] duration-500 ease-swift",
          // Green with room, amber as it tightens, red once it is out — so a
          // column of bars is read by colour first and length second.
          FILL_TONE[fillTone(clamped)],
        )}
        style={{ width: `${clamped * 100}%` }}
      />
      {/* Legend and reading ride *inside* the track, so the bar itself can run
       * the full width instead of surrendering a column to a three-letter
       * label. Both sit above the fill, and each will spend part of its life
       * on the accent and part on the empty track as the bar moves — weight
       * plus a shadow is what keeps type this small legible over both. */}
      <span
        aria-hidden
        className="relative pl-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[0.12em] text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]"
      >
        {label}
      </span>
      {caption && (
        <span
          aria-hidden
          className="relative ml-auto pr-1.5 font-mono text-[9px] font-semibold tabular-nums text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]"
        >
          {caption}
        </span>
      )}
    </span>
  );
}

/** Presence and activity only — see `hostTone` for why there is no fourth. */
const TONE_DOT: Record<string, string> = {
  active: "bg-tone-active",
  idle: "bg-tone-idle",
  offline: "bg-tone-offline",
};

export function LegionDot({
  tone,
  label,
  pulse = false,
  className,
}: {
  tone: string;
  label: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("relative inline-flex size-2 shrink-0 rounded-full", TONE_DOT[tone], className)}
    >
      {pulse && (
        <span
          aria-hidden
          className={cn("absolute inset-0 animate-ping rounded-full opacity-60", TONE_DOT[tone])}
        />
      )}
    </span>
  );
}

/**
 * What is running on a host, as the marks people recognise: the Claude Code
 * plate, the Codex plate, a terminal glyph — each with how many of it.
 *
 * This replaces a bare session count in the row because "2 Claude, 1 Codex" is
 * the thing a person actually wants to know about a machine, and it is the
 * thing that makes a fleet look like a fleet. The same `AgentIcon` the pane
 * headers and shortcut bar use, so a mark means the same everywhere.
 */
export function RunningIcons({
  running,
  /** Shown when nothing but shells are open — still worth saying. */
  fallbackCount,
  className,
}: {
  running: Array<{ command: string; count: number }>;
  fallbackCount: number;
  className?: string;
}) {
  // Nothing but shells: still a chip, and still a real answer — a machine with
  // five bare prompts on it is worth showing as such rather than as a number
  // floating beside a name.
  if (running.length === 0) {
    if (fallbackCount <= 0) return null;
    return (
      <span className={cn("flex shrink-0 items-center", className)}>
        <AgentChip count={fallbackCount} label={fallbackCount === 1 ? "shell" : "shells"} />
      </span>
    );
  }
  // Three marks is the most that fits beside a name at the sidebar's narrowest,
  // and a fourth distinct agent on one host is rare enough to live in the count.
  const shown = running.slice(0, MAX_AGENT_MARKS);
  const hidden = running.slice(MAX_AGENT_MARKS).reduce((total, agent) => total + agent.count, 0);
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)}>
      {shown.map((agent) => (
        <AgentChip
          key={agent.command}
          command={agent.command}
          count={agent.count}
          label={agentDisplayName(agent.command)}
        />
      ))}
      {hidden > 0 && (
        <span className="rounded-sm bg-muted px-1.5 py-1 font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
          +{hidden}
        </span>
      )}
    </span>
  );
}

/**
 * One agent and how many of it, on a plate of their own.
 *
 * The plate is what makes the pair read as one fact. Without it the mark and
 * its number are two loose objects in a row that already has a name and a
 * dot, and the eye has to work out which number belongs to which icon. The
 * count is always drawn, including "1": a chip that sometimes has a number and
 * sometimes does not is a different shape each time, and this is a row that
 * gets scanned rather than read.
 */
function AgentChip({
  command,
  count,
  label,
}: {
  /** Omitted for the shell chip, which is what an absent command resolves to. */
  command?: string;
  count: number;
  label: string;
}) {
  return (
    <span
      // rounded-sm outside, 4px inside: the 2px inset makes the two radii
      // concentric, which is what stops a nested plate looking pasted on.
      className="flex items-center gap-1 rounded-sm bg-muted py-0.5 pl-0.5 pr-1.5"
      title={`${count} × ${label}`}
    >
      <AgentIcon command={command ?? null} size={14} className="rounded-[4px]" />
      <span className="font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
        {count}
      </span>
    </span>
  );
}

/** "claude ×2 · codex" — what is running, in the mono the panes label with. */
export function RunningLabel({
  running,
  className,
}: {
  running: Array<{ command: string; count: number }>;
  className?: string;
}) {
  if (running.length === 0) return null;
  return (
    <span className={cn("truncate font-mono text-[10px] text-muted-foreground", className)}>
      {running
        .map((agent) => (agent.count > 1 ? `${agent.command} ×${agent.count}` : agent.command))
        .join(" · ")}
    </span>
  );
}

/** A small figure with its caption under it — the tile and page stat blocks. */
export function Stat({
  value,
  label,
  accent = false,
}: {
  value: ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      {/* App chrome, so the app's own type: the poster face (Rowdies) is
       * deliberately confined to marketing surfaces (see lib/fonts.ts). Weight
       * and tabular figures carry the emphasis instead. */}
      <div
        className={cn(
          "text-xl font-semibold leading-none tabular-nums",
          accent ? "text-brand-accent" : "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}
