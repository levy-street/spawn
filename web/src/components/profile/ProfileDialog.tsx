"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Flame, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { LegionDot, Stat } from "@/components/legion/legion-parts";
import { closeProfile, useProfileDialog } from "@/components/profile/profile-dialog-store";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { type Profile, profile as profileApi } from "@/lib/api";
import { calendar, formatBytes, formatDuration, specLine } from "@/lib/legion";
import { cn } from "@/lib/utils";

/**
 * Your profile: who you are, the legion as it stands, and what it has done
 * over time.
 *
 * This is the loud surface — the one opened on purpose, where the sidebar
 * strip is the quiet one. Everything here is a lifetime figure or a calendar,
 * so it is deliberately *not* live: it fetches once on open and again only if
 * you come back to it, rather than joining the app's polling.
 *
 * The history behind it is the `legion_days` rollup, which exists because
 * session rows are deleted with their workspaces — a profile computed from the
 * sessions table would show a person's history shrinking as they tidy up.
 */

/** Squares per row in the calendar. A week, so the columns mean something. */
const WEEK = 7;

export function ProfileDialog() {
  const open = useProfileDialog();
  const query = useQuery({
    queryKey: ["profile"],
    queryFn: profileApi.get,
    // Only while the dialog is mounted and visible; the profile is a place you
    // visit, not something the app should be polling behind your back.
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeProfile())}>
      <DialogContent size="full-mobile" data-testid="profile-dialog">
        <DialogTitle className="sr-only">Profile</DialogTitle>
        <DialogDescription className="sr-only">
          Your account, the machines you have possessed, and what your legion has done over time.
        </DialogDescription>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isLoading && <ProfileSkeleton />}
          {query.error && (
            <p className="p-6 text-sm text-destructive" role="alert">
              Could not load your profile: {String(query.error)}
            </p>
          )}
          {query.data && <ProfileBody profile={query.data} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

function ProfileBody({ profile }: { profile: Profile }) {
  const { totals } = profile;
  const grid = useMemo(
    () => calendar(profile.days, profile.today, profile.history_days),
    [profile.days, profile.today, profile.history_days],
  );
  const memory = formatBytes(totals.memory_bytes);

  return (
    <div className="flex flex-col gap-7 p-5 sm:p-6">
      <header className="flex flex-wrap items-center gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-full bg-secondary text-lg font-semibold uppercase text-secondary-foreground">
          {profile.email.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{profile.email}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Possessing machines since {formatDate(profile.created_at)}
            {totals.current_streak > 0 && (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1 text-foreground">
                  <Flame className="size-3 text-brand-accent" aria-hidden />
                  {totals.current_streak} day streak
                </span>
              </>
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            closeProfile();
            openSettings("account");
          }}
        >
          <Settings2 className="size-4" aria-hidden />
          Account settings
        </Button>
      </header>

      {/* The flex, stated plainly. Static spec first — "214 cores" is the line
       * that gets read aloud, where live utilisation is a wiggling number. */}
      <section aria-label="Your legion" className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            The legion
          </h3>
          <ShareLegion profile={profile} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            value={`${totals.hosts_online}/${totals.hosts}`}
            label={totals.hosts === 1 ? "host online" : "hosts online"}
          />
          {/* Zero cores means every daemon is silent about its spec, which is
           * a different thing from a machine with no CPU — say nothing. */}
          {totals.cores > 0 && <Stat value={totals.cores} label="cores possessed" />}
          {memory && <Stat value={memory} label="memory" />}
          <Stat value={totals.sessions_live} label="live now" accent={totals.sessions_live > 0} />
          <Stat value={totals.sessions_started} label="sessions summoned" />
        </div>
      </section>

      <section aria-label="Machines" className="space-y-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Machines
        </h3>
        {profile.hosts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No hosts possessed yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {profile.hosts.map((host) => {
              const spec = specLine(host);
              return (
                <li
                  key={host.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <LegionDot
                    tone={host.status === "online" ? "active" : "offline"}
                    label={host.status}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{host.name}</span>
                  {spec && (
                    <span className="font-mono text-[10px] text-muted-foreground">{spec}</span>
                  )}
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {host.session_count} {host.session_count === 1 ? "session" : "sessions"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Activity" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Last {profile.history_days} days
          </h3>
          <p className="text-xs text-muted-foreground">
            {totals.active_days} active {totals.active_days === 1 ? "day" : "days"} ·{" "}
            {formatDuration(totals.session_seconds)} of session time
          </p>
        </div>
        <Heatmap grid={grid} />
        <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1 text-xs text-muted-foreground">
          <span>
            Longest streak <span className="text-foreground">{totals.longest_streak}</span>
          </span>
          <span>
            Most hosts at once <span className="text-foreground">{totals.peak_hosts_online}</span>
          </span>
          <span>
            Most sessions at once <span className="text-foreground">{totals.peak_sessions}</span>
          </span>
        </div>
      </section>

      {profile.agents.length > 0 && (
        <section aria-label="Agents summoned" className="space-y-2">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Agents summoned
          </h3>
          <ul className="space-y-1.5">
            {profile.agents.map((agent) => {
              const most = profile.agents[0]?.count ?? 1;
              return (
                <li key={agent.command} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 truncate font-mono text-xs">{agent.command}</span>
                  <span
                    aria-hidden
                    className="h-1.5 min-w-0.5 rounded-full bg-brand-accent/70"
                    style={{ width: `${Math.max(2, (agent.count / most) * 100)}%` }}
                  />
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {agent.count}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="pt-1 text-[11px] leading-5 text-muted-foreground">
            Counted from the foreground process name your daemons already report for pane labels —
            never arguments, paths, or anything from inside a session.
          </p>
        </section>
      )}
    </div>
  );
}

const HEAT_CLASS = [
  "bg-muted-foreground/10",
  "bg-brand-accent/25",
  "bg-brand-accent/45",
  "bg-brand-accent/70",
  "bg-brand-accent",
];

function Heatmap({ grid }: { grid: ReturnType<typeof calendar> }) {
  if (grid.length === 0) return null;
  // Columns of weeks, so a vertical band reads as "Tuesdays" and the whole
  // block reads as a habit rather than as a strip of noise.
  const weeks: (typeof grid)[] = [];
  for (let index = 0; index < grid.length; index += WEEK) {
    weeks.push(grid.slice(index, index + WEEK));
  }
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-[3px] pb-1">
        {weeks.map((week) => (
          <div key={week[0]?.day} className="flex flex-col gap-[3px]">
            {week.map((cell) => (
              <span
                key={cell.day}
                title={`${cell.day}: ${cell.sessions} ${cell.sessions === 1 ? "session" : "sessions"}`}
                className={cn("size-3 rounded-[2px]", HEAT_CLASS[cell.level])}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The shareable line. Counts and shapes only — no hostnames, no paths, no repo
 * names: the people most likely to post this are the people most careful about
 * what a screenshot leaks, so the safe version is the only version.
 */
function ShareLegion({ profile }: { profile: Profile }) {
  const [copied, setCopied] = useState(false);
  const { totals } = profile;
  const line = [
    `${totals.hosts} ${totals.hosts === 1 ? "host" : "hosts"} possessed`,
    totals.cores > 0 ? `${totals.cores} cores` : null,
    formatBytes(totals.memory_bytes),
    `${totals.sessions_started} agents summoned`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`${line} — SPAWN D`);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          // A denied clipboard is the browser's decision, not a fault worth a
          // destructive toast — say what happened and leave the text on screen.
          toast("Your browser blocked the clipboard. Copy the line above instead.");
        }
      }}
    >
      <Copy className="size-3" aria-hidden />
      {copied ? "Copied" : "Copy stats"}
    </Button>
  );
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
