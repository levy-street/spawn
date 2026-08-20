"use client";

import type { TrustEventVM } from "./types";

/**
 * The full trust log (R4): every link, connection, removal, and recovery event
 * as one plain sentence, newest first. No filters — reading it is the feature.
 */
export function TrustHistory({ events }: { events: TrustEventVM[] }) {
  return (
    <div className="w-[420px] max-w-full">
      <header className="mb-4">
        <h1 className="text-xl font-medium tracking-tight text-zinc-100">History</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every change to who can reach your machines. If something here surprises you, remove the
          device it names.
        </p>
      </header>
      <ul className="divide-y divide-zinc-800/80 rounded-xl border border-zinc-800 bg-zinc-900/40">
        {events.map((e) => (
          <li key={e.id} className="flex items-baseline gap-3 px-4 py-3">
            <span
              className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                e.kind === "removed"
                  ? "bg-red-400/80"
                  : e.kind === "recovery"
                    ? "bg-emerald-400/80"
                    : "bg-zinc-600"
              }`}
            />
            <span className="min-w-0 flex-1 text-sm leading-relaxed text-zinc-300">{e.text}</span>
            <span className="shrink-0 text-xs text-zinc-600">{e.when}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
