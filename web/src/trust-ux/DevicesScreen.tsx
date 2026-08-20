"use client";

import {
  Chip,
  IconButton,
  IconChevronRight,
  IconComputer,
  IconEllipsis,
  IconKey,
  IconLaptop,
  IconPhone,
  IconPlus,
} from "./bits";
import type { ComputerVM, DeviceVM, RecoveryVM, TrustEventVM } from "./types";

export interface DevicesScreenProps {
  devices: DeviceVM[];
  computers: ComputerVM[];
  recovery: RecoveryVM;
  /** Newest first; the screen shows the first three. */
  history: TrustEventVM[];
  onLinkDevice?: () => void;
  onConnectComputer?: () => void;
  onDeviceOptions?: (id: string) => void;
  onTurnOnRecovery?: () => void;
  onResetRecovery?: () => void;
  onShowHistory?: () => void;
}

/**
 * The single trust destination. Row provenance ("Linked by …") and the history
 * lines are the visible audit surface (R4): every endorsement is a sentence here.
 */
export function DevicesScreen({
  devices,
  computers,
  recovery,
  history,
  onLinkDevice,
  onConnectComputer,
  onDeviceOptions,
  onTurnOnRecovery,
  onResetRecovery,
  onShowHistory,
}: DevicesScreenProps) {
  return (
    <div className="w-[420px] max-w-full space-y-7">
      <header>
        <h1 className="text-xl font-medium tracking-tight text-zinc-100">Devices</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {recovery.on
            ? "Every device here can reach every computer. Only you can add to this list."
            : "Linked devices reach the computers you've connected. Only you can add to this list."}
        </p>
      </header>

      {recovery.on ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-400/10 text-emerald-400">
            <IconKey />
          </span>
          <div className="min-w-36 flex-1">
            <p className="text-sm font-medium text-zinc-100">Recovery is on</p>
            <p className="text-xs text-zinc-500">{recovery.detail}</p>
          </div>
          <button
            type="button"
            onClick={onResetRecovery}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-200"
          >
            Reset
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 text-amber-400">
            <IconKey />
          </span>
          <div className="min-w-44 flex-1">
            <p className="text-sm font-medium text-zinc-100">Recovery is off</p>
            <p className="text-xs leading-relaxed text-zinc-400">
              Lose your last device and you start over — every computer set up again from its
              terminal.
            </p>
          </div>
          <button
            type="button"
            onClick={onTurnOnRecovery}
            className="shrink-0 rounded-lg bg-amber-400/15 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-400/25 max-sm:ml-12"
          >
            Turn on
          </button>
        </div>
      )}

      <section>
        <SectionHeader label="Your devices" action="Link a device" onAction={onLinkDevice} />
        <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-900/40">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-300">
                {d.kind === "phone" ? <IconPhone /> : <IconLaptop />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">{d.name}</span>
                  {d.isThisDevice && <Chip>This device</Chip>}
                </div>
                {/* The provenance is the audit surface — it wraps rather than
                    truncates on narrow screens, where the who/when matters most. */}
                <p className="text-xs leading-relaxed text-zinc-500 sm:truncate">
                  {d.provenance}
                  <span className="sm:hidden"> · {seenLabel(d.lastSeen)}</span>
                </p>
              </div>
              <span className="hidden shrink-0 text-xs text-zinc-600 sm:block">
                {seenLabel(d.lastSeen)}
              </span>
              <IconButton label={`Options for ${d.name}`} onClick={() => onDeviceOptions?.(d.id)}>
                <IconEllipsis />
              </IconButton>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader
          label="Your computers"
          action="Connect a computer"
          onAction={onConnectComputer}
        />
        <div className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-900/40">
          {computers.map((c) => (
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
    row can't be confused ("Linked … Jun 3" vs "Seen Aug 12"). */
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
