"use client";

import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import Link from "next/link";
import type {
  ConnInfo,
  SignalingTrustLevel,
  SocketState,
} from "@/components/terminal/useAgentSocket";
import { DropdownMenu, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import {
  SIGNED_RTC_REFUSAL_DETAIL,
  SIGNED_RTC_REFUSAL_NEXT_STEP,
  type SignedRtcRefusalReason,
} from "@/lib/signed-rtc-trust";
import { cn } from "@/lib/utils";

/** Snapshot of an agent terminal's transport, surfaced by <Terminal>. */
export interface AgentConnectionInfo extends ConnInfo {
  socketState: SocketState;
  v2: boolean;
  dcOpen: boolean;
  /** Set when the connection was refused because the host identity could not
   * be verified against a local pin. A refusal is terminal, not a retry. */
  signedRtcRefusal?: SignedRtcRefusalReason | null;
  /** How this connection's signaling was authenticated, once decided. */
  signalingTrust?: SignalingTrustLevel | null;
  /** The agent's host, once known — lets a refusal deep-link the safe next
   * step (the host page, where removal + re-possession live). */
  hostId?: string | null;
}

const TRUST_VIEW: Record<
  SignalingTrustLevel,
  { icon: typeof ShieldCheck; tint: string; label: string; detail: string }
> = {
  verified: {
    icon: ShieldCheck,
    tint: "text-emerald-500",
    label: "verified",
    detail:
      "Verified: offers are signed by this browser and the host's identity matches your approved pin end to end.",
  },
  first_contact: {
    icon: ShieldAlert,
    tint: "text-amber-500",
    label: "first contact",
    detail:
      "Signed, but this device is meeting this host for the first time — it took the server's word for the host's identity. Signing in with your passkey verifies it fully; approving this device again from one that already reaches the host also hands it over.",
  },
  raw: {
    icon: ShieldOff,
    tint: "text-muted-foreground",
    label: "unverified",
    detail:
      "Unsigned connection: this host published no identity key, or this browser has no signing identity. Content is still end-to-end encrypted, but neither side's identity is verified.",
  },
};

// The refusal copy is shared with the host page and the file explorer so the
// story never forks between surfaces (docs/TRUST_UX.md voice; review R-b).
const REFUSAL_DETAIL = SIGNED_RTC_REFUSAL_DETAIL;

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
  const trust = info.signalingTrust ? TRUST_VIEW[info.signalingTrust] : null;
  const TrustIcon = trust?.icon ?? null;
  const v2TrustDetail = info.dcOpen
    ? "spawn.v2 — terminal bytes and history are endpoint-to-endpoint; the server receives signaling and disclosed activity only"
    : "spawn.v2 — mandatory endpoint-to-endpoint terminal channels are negotiating; there is no server content fallback";
  const title = [
    view.detail,
    trust?.detail ?? null,
    info.rttMs != null ? `round trip ${info.rttMs} ms` : null,
    info.protocol ? `via ${info.protocol}` : null,
    info.dcOpen ? "DataChannel open" : null,
    v2TrustDetail,
  ]
    .filter(Boolean)
    .join(" · ");

  const refusalNextStep = info.signedRtcRefusal
    ? (SIGNED_RTC_REFUSAL_NEXT_STEP[info.signedRtcRefusal] ?? null)
    : null;
  const details: Array<[string, string]> = info.signedRtcRefusal
    ? [
        ["Security", REFUSAL_DETAIL[info.signedRtcRefusal]],
        ...(refusalNextStep ? ([["Next step", refusalNextStep]] as Array<[string, string]>) : []),
      ]
    : [
        ...(trust ? ([["Security", trust.detail]] as Array<[string, string]>) : []),
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
            {TrustIcon && trust && (
              <TrustIcon className={cn("size-3 shrink-0", trust.tint)} aria-hidden />
            )}
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
            {TrustIcon && trust && (
              <TrustIcon
                className={cn("size-3 shrink-0", trust.tint)}
                aria-label={`signaling: ${trust.label}`}
              />
            )}
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
      {info.signedRtcRefusal &&
        (info.signedRtcRefusal === "host_key_substituted" ||
          info.signedRtcRefusal === "host_key_revoked") &&
        info.hostId && (
          // The safe path forward, one click away: the host page carries the
          // removal (and, for a re-keyed host, the full explanation). Never an
          // "accept the new identity" control — that button cannot exist.
          <div className="px-2 py-1.5">
            <Link
              href={`/hosts/${info.hostId}`}
              data-testid="refusal-review-host"
              className="text-xs font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              Review this host
            </Link>
          </div>
        )}
    </DropdownMenu>
  );
}
