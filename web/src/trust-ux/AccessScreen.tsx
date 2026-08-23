"use client";

import {
  Button,
  Chip,
  IconButton,
  IconChevronRight,
  IconComputer,
  IconEllipsis,
  IconKey,
  IconLaptop,
  IconPhone,
  IconPlus,
  Menu,
  MenuItem,
} from "./bits";
import type { DeviceVM, HostVM, TrustEventVM } from "./types";

export interface AccessScreenProps {
  devices: DeviceVM[];
  hosts: HostVM[];
  /** Newest first; the screen shows the first three. */
  history: TrustEventVM[];
  /**
   * One-time tip shown when the account has no passkey: the R8 cost, stated
   * once and dismissible. There is no recovery object to manage — a passkey
   * (added in account settings) IS the safety net.
   */
  passkeyNudge?: boolean;
  onNewDevice?: () => void;
  onPossessHost?: () => void;
  onApproveDevice?: (id: string) => void;
  onDeviceOptions?: (id: string) => void;
  onAddPasskey?: () => void;
  onDismissNudge?: () => void;
  onShowHistory?: () => void;
  /** Desktop settings pane: full-width rows instead of the 420px column. */
  wide?: boolean;
  /** Row whose options menu is open (Rename / Remove — everything a row can do). */
  openMenuDeviceId?: string;
  onRenameDevice?: (id: string) => void;
  onRemoveDevice?: (id: string) => void;
}

/**
 * The single trust destination, named for what it governs. A device appears
 * here the moment it signs in (R4: every sign-in is visible immediately);
 * approval is the transition, not the insertion. Row provenance and the
 * history lines are the audit surface.
 */
export function AccessScreen({
  devices,
  hosts,
  history,
  passkeyNudge = false,
  onNewDevice,
  onPossessHost,
  onApproveDevice,
  onDeviceOptions,
  onAddPasskey,
  onDismissNudge,
  onShowHistory,
  wide = false,
  openMenuDeviceId,
  onRenameDevice,
  onRemoveDevice,
}: AccessScreenProps) {
  return (
    <div className={`${wide ? "w-full max-w-2xl" : "w-[420px]"} max-w-full space-y-7`}>
      <header>
        <h1 className="text-xl font-medium tracking-tight text-zinc-100">Access</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every approved device reaches every host — and only you can approve one.
        </p>
      </header>

      <section>
        <SectionHeader label="Your devices" action="New device" onAction={onNewDevice} />
        <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-900/40">
          {devices.map((d) => (
            <div key={d.id} className="relative flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-300">
                {d.kind === "phone" ? <IconPhone /> : <IconLaptop />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">{d.name}</span>
                  {d.isThisDevice && <Chip>This device</Chip>}
                  {d.waiting && (
                    <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                      Waiting for approval
                    </span>
                  )}
                </div>
                {/* The provenance is the audit surface — it wraps rather than
                    truncates on narrow screens, where the who/when matters most. */}
                <p className="text-xs leading-relaxed text-zinc-500 sm:truncate">
                  {d.provenance}
                  {!d.waiting && <span className="sm:hidden"> · {seenLabel(d.lastSeen)}</span>}
                </p>
              </div>
              {d.waiting ? (
                <Button onClick={() => onApproveDevice?.(d.id)}>Approve…</Button>
              ) : (
                <>
                  <span className="hidden shrink-0 text-xs text-zinc-600 sm:block">
                    {seenLabel(d.lastSeen)}
                  </span>
                  <IconButton
                    label={`Options for ${d.name}`}
                    onClick={() => onDeviceOptions?.(d.id)}
                  >
                    <IconEllipsis />
                  </IconButton>
                </>
              )}
              {openMenuDeviceId === d.id && (
                <div className="absolute right-3 top-11 z-10">
                  <Menu>
                    <MenuItem onClick={() => onRenameDevice?.(d.id)}>Rename</MenuItem>
                    <MenuItem danger onClick={() => onRemoveDevice?.(d.id)}>
                      Remove…
                    </MenuItem>
                  </Menu>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader label="Your hosts" action="Possess a host" onAction={onPossessHost} />
        <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-900/40">
          {hosts.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-300 ${c.online ? "" : "opacity-60"}`}
              >
                <IconComputer />
              </span>
              <div className={`min-w-0 flex-1 ${c.online ? "" : "opacity-60"}`}>
                <p className="truncate font-mono text-sm text-zinc-100">{c.name}</p>
                <p className="text-xs leading-relaxed text-zinc-500 sm:truncate">{c.provenance}</p>
              </div>
              <span
                className={`flex shrink-0 items-center gap-1.5 text-xs ${
                  c.online ? "text-emerald-400" : "text-zinc-600"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${c.online ? "bg-emerald-400" : "bg-zinc-700"}`}
                />
                {c.online ? "Online" : "Offline"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {passkeyNudge && (
        <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400">
            <IconKey />
          </span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-400">
            If you lose every device, a passkey brings everything back. You can add one in account
            settings.
          </p>
          <button
            type="button"
            onClick={onAddPasskey}
            className="shrink-0 text-xs font-medium text-zinc-300 transition-colors hover:text-zinc-100"
          >
            Add passkey
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismissNudge}
            className="shrink-0 text-zinc-600 transition-colors hover:text-zinc-300"
          >
            ×
          </button>
        </div>
      )}

      <section>
        <SectionHeader label="History" action="Everything" onAction={onShowHistory} plain />
        <ul className="space-y-2.5">
          {history.slice(0, 3).map((e) => (
            <li key={e.id} className="flex items-baseline gap-2.5 text-sm">
              <span
                className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                  e.kind === "removed" ? "bg-red-400/80" : "bg-zinc-600"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-zinc-400">{e.text}</span>
              <span className="shrink-0 text-xs text-zinc-600">{e.when}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** "Now" stays bare; any other last-seen value gets its label so two dates on a
    row can't be confused ("Approved … Jun 3" vs "Seen Aug 12"). */
function seenLabel(lastSeen: string): string {
  return lastSeen === "Now" ? "Now" : `Seen ${lastSeen}`;
}

function SectionHeader({
  label,
  action,
  onAction,
  plain = false,
}: {
  label: string;
  action: string;
  onAction?: () => void;
  plain?: boolean;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</h2>
      <button
        type="button"
        onClick={onAction}
        className="flex items-center gap-1 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100"
      >
        {!plain && <IconPlus className="size-3.5" />}
        {action}
        {plain && <IconChevronRight className="size-3.5" />}
      </button>
    </div>
  );
}
