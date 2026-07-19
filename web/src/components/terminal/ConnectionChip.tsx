"use client";

import type { ConnInfo, SocketState } from "@/components/terminal/useAgentSocket";
import { DropdownMenu, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import type { SignedRtcRefusalReason } from "@/lib/signed-rtc-trust";
import { cn } from "@/lib/utils";

/** Snapshot of an agent terminal's transport, surfaced by <Terminal>. */
export interface AgentConnectionInfo extends ConnInfo {
  socketState: SocketState;
  v2: boolean;
  dcOpen: boolean;
  /** Set when the connection was refused because the host identity could not
   * be verified against a local pin. A refusal is terminal, not a retry. */
  signedRtcRefusal?: SignedRtcRefusalReason | null;
}

const REFUSAL_DETAIL: Record<SignedRtcRefusalReason, string> = {
  host_key_substituted:
    "This host presented a different identity key than the one you approved. Connection blocked to prevent interception — re-verify and re-approve the host to reconnect.",
  host_key_revoked: "You revoked this host's approved key. Re-approve it to reconnect.",
  host_key_withheld:
    "This host's identity key is absent from the server response, but you hold a saved pin for it. Connection blocked.",
  browser_identity_unavailable:
    "This browser has no signing identity for your account, so it cannot make a verified connection to this pinned host.",
  pin_storage_error: "Your saved host pins could not be read; connection blocked to stay safe.",
};

interface ChipView {
  dot: string;
  label: string;
  pulse?: boolean;
  detail: string;
}

const KIND_LABEL: Record<NonNullable<ConnInfo["kind"]>, string> = {
  direct: "direct",
  stun: "p2p",
  relay: "relay",
};

const KIND_DETAIL: Record<NonNullable<ConnInfo["kind"]>, string> = {
  direct: "Direct peer-to-peer (host candidates)",
  stun: "Peer-to-peer via STUN-discovered addresses",
  relay: "TURN relay (encrypted end-to-end)",
};

function viewFor(info: AgentConnectionInfo): ChipView {
  if (info.signedRtcRefusal) {
    return { dot: "bg-red-500", label: "blocked", detail: REFUSAL_DETAIL[info.signedRtcRefusal] };
  }
  if (info.socketState === "closed" || info.socketState === "error") {
    return { dot: "bg-red-500", label: "offline", detail: "Control connection lost" };
  }
  if (info.socketState !== "open") {
    return { dot: "bg-muted-foreground", label: "connecting", pulse: true, detail: "Connecting…" };
  }
  if (!info.dcOpen) {
    return {
      dot: "bg-amber-400",
      label: "channel…",
      pulse: true,
      detail: "Negotiating the mandatory encrypted terminal channels",
    };
  }
  const kind = info.kind ?? "direct";
  return {
    dot: kind === "relay" ? "bg-amber-400" : kind === "stun" ? "bg-sky-400" : "bg-emerald-500",
    label: info.rttMs != null ? `${KIND_LABEL[kind]} · ${info.rttMs} ms` : KIND_LABEL[kind],
    detail: KIND_DETAIL[kind],
  };
}

export function ConnectionChip({
  info,
  compact = false,
  className,
}: {
  info: AgentConnectionInfo | null;
  compact?: boolean;
  className?: string;
}) {
  if (!info) return null;
  const view = viewFor(info);
  const v2TrustDetail = info.dcOpen
    ? "spawn.v2 — terminal bytes and history are endpoint-to-endpoint; the server receives signaling and disclosed activity only"
    : "spawn.v2 — mandatory endpoint-to-endpoint terminal channels are negotiating; there is no server content fallback";
  const title = [
    view.detail,
    info.rttMs != null ? `round trip ${info.rttMs} ms` : null,
    info.protocol ? `via ${info.protocol}` : null,
    info.dcOpen ? "DataChannel open" : null,
    v2TrustDetail,
  ]
    .filter(Boolean)
    .join(" · ");

  const details: Array<[string, string]> = info.signedRtcRefusal
    ? [["Security", REFUSAL_DETAIL[info.signedRtcRefusal]]]
    : [
        ["Path", view.detail],
        ["Round trip", info.rttMs != null ? `${info.rttMs} ms` : "—"],
        ["Transport", info.protocol ?? "—"],
        [
          "Channel",
          info.dcOpen
            ? "DataChannel open"
            : info.socketState !== "open"
              ? "disconnected"
              : "negotiating",
        ],
        ["Protocol", v2TrustDetail],
      ];

  return (
    <DropdownMenu
      className={className}
      menuClassName="w-72"
      renderTrigger={(props) =>
        compact ? (
          <button
            {...props}
            type="button"
            title={title}
            aria-label={`Connection details: ${view.label}`}
            className="flex items-center gap-1 rounded p-1 text-[10px] text-muted-foreground hover:bg-accent/60"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                view.dot,
                view.pulse && "animate-pulse",
              )}
              aria-hidden
            />
            {info.dcOpen && info.rttMs != null && (
              <span className="tabular-nums">{info.rttMs}ms</span>
            )}
          </button>
        ) : (
          <button
            {...props}
            type="button"
            title={title}
            aria-label={`Connection details: ${view.label}`}
            className="flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                view.dot,
                view.pulse && "animate-pulse",
              )}
              aria-hidden
            />
            <span className="whitespace-nowrap tabular-nums">{view.label}</span>
          </button>
        )
      }
    >
      <DropdownMenuLabel>Connection</DropdownMenuLabel>
      {details.map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 px-2 py-1 text-xs">
          <span className="shrink-0 text-muted-foreground">{key}</span>
          <span className="min-w-0 text-right">{value}</span>
        </div>
      ))}
    </DropdownMenu>
  );
}
