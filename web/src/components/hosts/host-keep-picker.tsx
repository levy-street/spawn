"use client";

import { useMemo, useState } from "react";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import type { Host } from "@/lib/api";
import { hosts } from "@/lib/api";
import { formatHostPlatform } from "@/lib/host-platform";
import { relativeTime } from "@/lib/sessions";
import { cn } from "@/lib/utils";

/**
 * "Which machines do you want to keep?" — the one question two different
 * billing moments both come down to (docs/BILLING.md §5.6, §5.7), and the only
 * thing in this product that releases a host on the way to a plan change.
 *
 * It is a question, never an action the app takes for you. The server refuses
 * to release a host on a billing signal at all, so the unchosen machines are
 * released by the caller, through the ordinary `DELETE /api/hosts/{id}`, only
 * after a person has explicitly chosen. That path frees each slot
 * synchronously, retains the `HostKeyClaim` so a machine can only ever return
 * to this account, and closes the live daemon socket with `4001
 * "host revoked"`.
 *
 * This module holds only the shared parts: the selection, the list, and the
 * release. How many must be chosen is the caller's business, and the two
 * callers differ on purpose — a downgrade asks for exactly the number the new
 * plan admits, while reconciling an over-limit account accepts fewer, and
 * accepts none.
 */

/**
 * The selection, capped at `keepLimit` and self-healing.
 *
 * A host released underneath us — another tab, another device — drops out of
 * the count rather than staying "kept", because the number on screen is a
 * promise about machines that still exist.
 */
export function useHostKeepSelection(hostList: readonly Host[], keepLimit: number) {
  const [kept, setKept] = useState<readonly string[]>([]);
  const ids = useMemo(() => hostList.map((host) => host.id), [hostList]);
  const selected = useMemo(() => kept.filter((id) => ids.includes(id)), [kept, ids]);

  const toggle = (id: string) =>
    setKept((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= keepLimit
          ? current
          : [...current, id],
    );

  return {
    selected,
    toggle,
    keepNone: () => setKept([]),
    /** The ones the caller will release. Derived, never stored. */
    released: ids.filter((id) => !selected.includes(id)),
  };
}

/** Release every host the person did not keep, one call each, in order. */
export async function releaseHosts(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await hosts.remove(id);
  }
}

export function HostKeepPicker({
  hostList,
  keepLimit,
  selected,
  onToggle,
  disabled = false,
}: {
  hostList: readonly Host[];
  keepLimit: number;
  selected: readonly string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="space-y-1.5" data-testid="host-keep-picker">
      {hostList.map((host) => {
        const checked = selected.includes(host.id);
        // Full, and this is not one of the chosen: the box is inert rather
        // than silently ignoring the click.
        const blocked = !checked && selected.length >= keepLimit;
        const lastSeen = relativeTime(host.last_seen_at);
        return (
          <li key={host.id}>
            <label
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-md border p-2.5 transition-colors",
                checked
                  ? "border-brand-accent/60 bg-accent/40"
                  : "border-border hover:bg-accent/20",
                (disabled || blocked) && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || blocked}
                onChange={() => onToggle(host.id)}
                aria-label={`Keep ${host.name}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusDot
                    tone={hostStatusTone(host.status)}
                    label={host.status === "online" ? "online" : "offline"}
                  />
                  <span className="truncate text-sm font-medium">{host.name}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatHostPlatform(host)}
                  {lastSeen === null ? "" : ` · last seen ${lastSeen}`}
                </p>
              </div>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** "2 of 3 chosen" — the running count that makes the confirm button legible. */
export function keepCountLabel(selected: number, keepLimit: number): string {
  return `${selected} of ${keepLimit} chosen`;
}
