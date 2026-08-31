"use client";

import { Lock, LockOpen, PlugZap, ShieldAlert, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { REFUSAL_DETAIL } from "@/components/terminal/ConnectionChip";
import type { SocketState } from "@/components/terminal/useSessionSocket";
import type { SignedRtcRefusalReason } from "@/lib/signed-rtc-trust";
import { cn } from "@/lib/utils";

/** Held back this long before appearing: a channel that opens promptly should
 *  never flash a "connecting" card on its way in. */
const ENTER_DELAY_MS = 240;
/** Matches the leave animation below; the node unmounts once it has played. */
const LEAVE_MS = 260;
/** How long the "channel open" beat holds before the overlay clears out. Long
 *  enough to read as an outcome rather than a flicker, short enough that the
 *  shell's first prompt is never left waiting behind it. */
const SECURED_HOLD_MS = 420;
/** A connect that has not landed by here is not "about to" — say so. */
const SLOW_AFTER_MS = 8_000;

type Stage =
  | "blocked"
  | "disabled"
  | "host-offline"
  | "dropped"
  | "reaching"
  | "securing"
  | "secured"
  | "unauthorized";

/** How one half of the drawn channel reads: carrying (dashes drifting toward
 *  the padlock), not up yet (a still dashed gap), or settled (a solid line). */
type LineState = "flowing" | "waiting" | "solid";

interface StageView {
  title: string;
  body: string;
  icon: typeof Lock;
  /** Tint for the plate's glyph, ring and the channel line either side of it. */
  tone: string;
  ring: string;
  /** The near half (this browser to the server) and the far half (the server
   *  on to the host), in that order. */
  lines: [LineState, LineState];
}

function stageFor(
  socketState: SocketState,
  v3: boolean,
  dcOpen: boolean,
  refusal: SignedRtcRefusalReason | null | undefined,
  hostOffline: boolean,
): Stage {
  if (refusal) return "blocked";
  if (socketState === "unauthorized") return "unauthorized";
  if (socketState === "disabled") return "disabled";
  if (socketState === "open") return !v3 || dcOpen ? "secured" : "securing";
  if (hostOffline) return "host-offline";
  if (socketState === "closed" || socketState === "error") return "dropped";
  return "reaching";
}

function viewFor(
  stage: Stage,
  host: string | null,
  refusal: SignedRtcRefusalReason | null | undefined,
  slow: boolean,
): StageView {
  const where = host ? ` to ${host}` : "";
  switch (stage) {
    case "unauthorized":
      return {
        title: "You've been signed out.",
        body: "Sign in to reconnect to this session.",
        icon: ShieldAlert,
        tone: "text-destructive",
        ring: "ring-destructive/40",
        lines: ["waiting", "waiting"],
      };
    case "disabled":
      return {
        title: "Transport disabled by this server",
        body: "This server is not offering the encrypted terminal transport.",
        icon: Unplug,
        tone: "text-muted-foreground",
        ring: "ring-border",
        lines: ["waiting", "waiting"],
      };
    case "blocked":
      return {
        title: "Connection blocked",
        body: refusal
          ? REFUSAL_DETAIL[refusal]
          : "This host's identity could not be verified, so no channel was opened.",
        icon: ShieldAlert,
        tone: "text-destructive",
        ring: "ring-destructive/40",
        lines: ["waiting", "waiting"],
      };
    case "host-offline":
      return {
        title: host ? `${host} is offline` : "Host is offline",
        body: "This pane picks up on its own the moment the host comes back.",
        icon: Unplug,
        tone: "text-muted-foreground",
        ring: "ring-border",
        lines: ["waiting", "waiting"],
      };
    case "dropped":
      return {
        title: `Reconnecting${where}`,
        body: slow
          ? "The link is still down. SPAWN D keeps retrying — nothing in the session is lost."
          : "The link dropped. SPAWN D is retrying automatically.",
        icon: PlugZap,
        tone: "text-warning",
        ring: "ring-warning/40",
        lines: ["flowing", "waiting"],
      };
    case "securing":
      return {
        title: `Connecting${where}`,
        body: slow
          ? "Still negotiating the encrypted terminal channel — a strict network can make this slow."
          : "Negotiating the encrypted terminal channel.",
        icon: LockOpen,
        tone: "text-muted-foreground",
        ring: "ring-border",
        lines: ["flowing", "flowing"],
      };
    case "secured":
      return {
        title: "Channel open",
        body: "Waking the shell.",
        icon: Lock,
        tone: "text-success",
        ring: "ring-success/45",
        lines: ["solid", "solid"],
      };
    default:
      return {
        title: `Connecting${where}`,
        body: slow
          ? "This is taking longer than usual — the host may be busy or unreachable."
          : "Opening the control link.",
        icon: LockOpen,
        tone: "text-muted-foreground",
        ring: "ring-border",
        lines: ["flowing", "waiting"],
      };
  }
}

/**
 * What a terminal shows before it has anything to show: the connection itself,
 * drawn as the two endpoints and the encrypted channel closing between them.
 *
 * It replaces a black rectangle carrying a 10px chip in the corner, so the pane
 * says which stage it is at, which host it is waiting on, and — when the host
 * is offline or the connection was refused — that waiting is not the answer.
 * It only ever covers an empty terminal: the first byte rendered (`painted`)
 * clears it for good, so a mid-session reconnect keeps the output on screen,
 * which is worth more than a status card over the top of it.
 */
export function ConnectingOverlay({
  socketState,
  v3,
  dcOpen,
  refusal,
  painted,
  hostName = null,
  hostOffline = false,
}: {
  socketState: SocketState;
  v3: boolean;
  dcOpen: boolean;
  refusal?: SignedRtcRefusalReason | null;
  /** True once anything at all has been written into the terminal buffer. */
  painted: boolean;
  hostName?: string | null;
  hostOffline?: boolean;
}) {
  const stage = stageFor(socketState, v3, dcOpen, refusal, hostOffline);
  const secured = stage === "secured";

  // The secured beat is deliberately held: the padlock closing is the one
  // moment in this overlay worth watching, and without the hold it would last
  // exactly as long as the fade that removes it.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!secured) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), SECURED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [secured]);

  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (secured) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [secured]);

  const done = painted || held;

  // Arm, then leave. The entry timer is cancelled by `done`, so a connection
  // that lands inside the entry delay never mounts the card at all.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (done) return;
    const timer = setTimeout(() => setEntered(true), ENTER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [done]);

  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!done || !entered) return;
    const timer = setTimeout(() => setGone(true), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [done, entered]);

  if (!entered || gone) return null;

  const view = viewFor(stage, hostName, refusal, slow);
  const Icon = view.icon;
  // The status chip in the corner is this pane's live region; announcing the
  // same transitions twice is worse than not announcing them here at all.
  return (
    <div
      aria-hidden
      data-testid="terminal-connecting"
      data-stage={stage}
      className={cn(
        "pointer-events-none absolute inset-0 z-[6] grid place-items-center p-4 duration-300",
        done
          ? "animate-out fade-out-0 zoom-out-95 fill-mode-forwards"
          : "animate-in fade-in-0 zoom-in-95",
      )}
    >
      <div className="flex max-w-full flex-col items-center gap-4 text-center">
        {/* The channel, literally: two endpoints, the padlock that has to close
            between them, and dashes drifting inward for as long as it is still
            being negotiated. A pane too narrow to hold the drawing drops it and
            keeps the copy, which carries the same state in words. */}
        <div className="flex items-center gap-2.5 @max-[16rem]/term:hidden">
          <Endpoint />
          <ChannelLine tone={view.tone} state={view.lines[0]} />
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-xl bg-card/60 ring-1 transition-colors duration-300",
              view.ring,
              view.tone,
              secured && "shadow-[0_0_20px_-8px_var(--color-success)]",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <ChannelLine tone={view.tone} state={view.lines[1]} reverse />
          <Endpoint />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{view.title}</p>
          <p className="mx-auto max-w-[42ch] text-xs leading-5 text-muted-foreground">
            {view.body}
          </p>
        </div>
      </div>
    </div>
  );
}

function Endpoint() {
  return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />;
}

/** One half of the channel: dashes drifting toward the padlock while that half
 *  is carrying, a still dashed gap while it is not, a solid hairline once there
 *  is nothing left to wait for. */
function ChannelLine({
  tone,
  state,
  reverse,
}: {
  tone: string;
  state: LineState;
  reverse?: boolean;
}) {
  return (
    <span
      className={cn(
        "h-px w-10 shrink-0 rounded-full transition-colors duration-300 @max-[22rem]/term:w-6",
        tone,
        state === "solid" ? "bg-current opacity-70" : "channel-line",
        state === "waiting" && "opacity-45",
        state === "flowing" && "channel-line-flow",
        state === "flowing" && reverse && "channel-line-rev",
      )}
    />
  );
}
