"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Circle, Copy, Loader2, Terminal } from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { NumberCheck } from "@/components/access/number-check";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PaceBar } from "@/components/ui/pace-bar";
import { StatusDot } from "@/components/ui/status";
import { useDesktopRelease } from "@/hooks/useDesktopRelease";
import { ApiError, auth, type DevicePendingApproval, type Host, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  createHostPairApprovalProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import {
  approveBrowserHostPin,
  type BrowserHostPinState,
  browserHostPinServerOrigin,
  loadBrowserHostPin,
} from "@/lib/browser-host-pins";
import { publishHostIntroductionBroadcast } from "@/lib/host-gossip";
import { PAIRING_FAILURE_COPY, pairingFailureCode } from "@/lib/pairing-errors";
import {
  detectPlatform,
  type InstallTargetId,
  installTargetForOS,
  installTargets,
  UNDETECTED_PLATFORM,
} from "@/lib/platform";
import {
  deriveSetupProgress,
  SETUP_PROGRESS_ACTIVE_LABELS,
  SETUP_PROGRESS_LABELS,
  type SetupProgressState,
  setupProgressStalledHint,
  visibleSetupSteps,
} from "@/lib/setup-progress";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";
import { cn } from "@/lib/utils";

class ApprovalIdentityError extends Error {}

/**
 * The `#k=` URL fragment is the possession ceremony's out-of-band channel:
 * the daemon appends its OWN public key to the approval URL locally, after
 * receiving `verification_uri`, and the fragment travels terminal→browser
 * without ever appearing in an HTTP request — the server cannot see, strip,
 * or rewrite it in flight. Its value is what the server-claimed host key
 * must equal EXACTLY; on any difference nothing is pinned or approved.
 *
 * Returns the wire-encoded key, `null` when an older approval link carries no
 * `k` fragment (the fingerprint-compare fallback), or
 * `"malformed"` when a `k` value is present but is not a canonical ed25519
 * wire key — a damaged or truncated link is refused, never downgraded.
 */
function readFragmentHostKey(hash: string): string | null | "malformed" {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const value = new URLSearchParams(raw).get("k");
  if (value === null) return null;
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : "malformed";
}

const REFUSAL_MISMATCH =
  "This host's identity could not be verified: the server presented a different identity " +
  "key than the one in your host's link. Nothing was trusted and no access was granted. " +
  "This can mean the connection is being tampered with — start over from the host's " +
  "terminal, on a network you trust.";
const REFUSAL_MALFORMED =
  "The identity check in this link (the part after '#') is damaged or cut off, so this " +
  "host could not be verified. Nothing was trusted. Copy the entire link from the host's " +
  "terminal and open it again.";

async function seedApprovedHostBinding(input: {
  accountId: string;
  hostPublicKey: string;
  hostFingerprint: string;
  knownHostId: string | null | undefined;
}): Promise<void> {
  const bind = (hostId: string) =>
    approveBrowserHostPin({
      accountId: input.accountId,
      origin: browserHostPinServerOrigin(),
      hostPublicKey: input.hostPublicKey,
      hostFingerprint: input.hostFingerprint,
      hostIds: [hostId],
    });
  try {
    if (input.knownHostId) {
      await bind(input.knownHostId);
      return;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const listed = await hosts.list().catch(() => null);
      const match = listed?.find((host) => host.host_public_key === input.hostPublicKey);
      if (match) {
        await bind(match.id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } catch {
    // The key pin is already durable. A later exact-key lookup heals the ID binding.
  }
}

export function ConnectHostSection(props: {
  onHostOnline?: (host: Host) => void;
  onPairingApproved?: (hostName: string) => void;
  /** Drop the card chrome and its heading: the host is already inside a framed,
   * titled surface (the onboarding sheet) and a second frame just doubles it. */
  frameless?: boolean;
  /** Forwarded to {@link HostApprovalForm}: read the possession handle and the
   * `#k=` identity fragment from the URL. Only `/device` sets this. */
  autoLoadFromUrl?: boolean;
  /** An approval completed before this surface mounted, but its daemon has not
   * connected yet. Resume at Approved instead of teaching installation again. */
  resumeApprovedHost?: Host | null;
  /**
   * Whether this surface's job carries on past the approval.
   *
   * `/device` and Add a machine end there: the ceremony's own "possessed" card
   * is the answer, and its Done means "possess another one". Onboarding does
   * not — the machine still has to arrive before the reader can be moved on —
   * and leaving that spent form owning the screen made Done, the only control
   * left on it, replace the answer with an empty approval surface while nothing
   * said the daemon was still connecting. Where this is set, the approval hands
   * the screen to the wait.
   */
  awaitsHostArrival?: boolean;
  /**
   * Hosts that were online before this ceremony began, and so cannot be its
   * result — the reading that stops one surface completing another machine's
   * approval.
   *
   * Left out, the surface takes that reading itself, the first time it hears
   * back from the server. That is right for a surface opened inside the app and
   * wrong for one that can mount again mid-ceremony: the hosts cache outlives
   * the component, so a later mount reads the very machine it is waiting for as
   * one that was already there, and then waits for it for ever. A caller that
   * knows the answer up front passes it and is immune to that.
   */
  priorOnlineHostIds?: readonly string[];
}): JSX.Element {
  const {
    onHostOnline,
    onPairingApproved,
    frameless = false,
    autoLoadFromUrl = false,
    resumeApprovedHost = null,
    awaitsHostArrival = false,
    priorOnlineHostIds,
  } = props;
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [chosenTarget, setChosenTarget] = useState<InstallTargetId | null>(null);
  const { nativeWindowsAvailable } = useDesktopRelease(platform.origin, null);
  const [copyPulse, setCopyPulse] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [locallyApproved, setLocallyApproved] = useState(false);
  /**
   * True when this visit arrived holding a specific approval — `?ref=`/`?code=`
   * from the link `spawnd possess` printed.
   *
   * Everything above the approve card exists to *get* a ceremony started:
   * install the daemon and wait for it to register. Arriving by link, all of
   * that is already done, and showing it turns a one-click confirmation into a
   * page of instructions for work the reader has finished. Derived from the URL
   * rather than the prop so a bare `/device` still offers installation.
   */
  const [linkApproval, setLinkApproval] = useState<boolean | "unknown">(
    // Unknown until the URL can be read, which is an effect — `window` is not
    // there during the server render. Guessing "no" for that tick paints the
    // installation layout and replaces it a frame later: a flash of exactly
    // the screen a link exists to skip.
    autoLoadFromUrl ? "unknown" : false,
  );

  useEffect(() => {
    if (!autoLoadFromUrl) return;
    const params = new URLSearchParams(window.location.search);
    setLinkApproval(Boolean(params.get("ref") ?? params.get("code")));
  }, [autoLoadFromUrl]);

  /** The confirm-only layout, which lasts exactly as long as the question does. */
  const showLinkConfirm = linkApproval !== false && !locallyApproved;
  /**
   * Whether the link ceremony still owns the screen.
   *
   * It keeps it for good on a surface that ends at the approval, and hands it
   * over on one that carries on waiting — see `awaitsHostArrival`.
   */
  const linkFormOwnsScreen = linkApproval !== false && !(awaitsHostArrival && locallyApproved);
  /** Nothing can be laid out yet without knowing how this visit arrived. */
  const arrivalUnknown = linkApproval === "unknown";
  const [now, setNow] = useState(() => Date.now());
  const notifiedRef = useRef(false);
  const initialOnlineIdsRef = useRef<Set<string> | null>(
    priorOnlineHostIds === undefined ? null : new Set(priorOnlineHostIds),
  );
  const progressStartedAtRef = useRef(Date.now());
  const hostsQ = useQuery({
    // A lane of its own, deliberately. This poll is what notices the machine,
    // and the surface has to paint its last milestone complete before whatever
    // is around it is told. On the page's own ["hosts"] lane both would see the
    // host in the same render, and the page would replace this whole surface in
    // the very frame that row was meant to tick over in.
    queryKey: ["hosts", "setup"],
    queryFn: hosts.list,
    refetchInterval: 3_000,
  });

  useEffect(() => {
    if (hostsQ.data === undefined || initialOnlineIdsRef.current !== null) return;
    initialOnlineIdsRef.current = new Set(
      hostsQ.data.filter((host) => host.status === "online").map((host) => host.id),
    );
  }, [hostsQ.data]);

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  const onlineHost = useMemo(() => {
    const listed = hostsQ.data ?? [];
    if (resumeApprovedHost) {
      return (
        listed.find((host) => host.id === resumeApprovedHost.id && host.status === "online") ?? null
      );
    }
    const initial = initialOnlineIdsRef.current;
    if (!initial) return null;
    const appeared = listed.find((host) => host.status === "online" && !initial.has(host.id));
    if (appeared) return appeared;
    // Nothing new appeared, but this surface approved a host in this session —
    // and on a remount (or a reload after approving) the daemon may already
    // have connected before the first poll, putting it in the "initial" set
    // and hiding it forever. Having approved here, an online host is ours.
    return locallyApproved ? (listed.find((host) => host.status === "online") ?? null) : null;
  }, [hostsQ.data, resumeApprovedHost, locallyApproved]);

  useEffect(() => {
    if (!onlineHost || notifiedRef.current) return;
    // Let the checked Online milestone paint before onboarding replaces this
    // surface with its existing success beat. The callback still fires once.
    const timer = window.setTimeout(() => {
      notifiedRef.current = true;
      onHostOnline?.(onlineHost);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [onlineHost, onHostOnline]);

  const progress = deriveSetupProgress({
    commandCopied,
    locallyApproved,
    resumeApprovedHost: resumeApprovedHost !== null,
    onlineHost: onlineHost !== null,
  });
  const progressKey = `${progress.completed.join(":")}:${progress.current ?? "done"}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: progressKey intentionally resets elapsed time on a milestone transition
  useEffect(() => {
    progressStartedAtRef.current = Date.now();
    setNow(Date.now());
  }, [progressKey]);
  useEffect(() => {
    if (progress.current === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progress.current]);
  const elapsedMs = now - progressStartedAtRef.current;
  const stalledHint = setupProgressStalledHint(progress, elapsedMs);
  /**
   * Approved here, and the machine has not appeared yet.
   *
   * This is its own state rather than an absence of one: the approve card
   * unmounts the instant an approval lands, so without something to take its
   * place the surface simply emptied out while the daemon was still starting.
   */
  const approvedAwaitingHost = locallyApproved && onlineHost === null;
  const showOnboardingProgress =
    !showLinkConfirm &&
    awaitsHostArrival &&
    (commandCopied || locallyApproved || resumeApprovedHost !== null);
  const showWaitingForMachine =
    !showLinkConfirm && !awaitsHostArrival && commandCopied && !linkFormOwnsScreen;

  const targetRows = installTargets(platform.origin, nativeWindowsAvailable);
  const defaultTarget = installTargetForOS(platform.os, nativeWindowsAvailable);
  const activeTarget =
    targetRows.find((target) => target.id === (chosenTarget ?? defaultTarget)) ?? targetRows[0];
  const displayedCommand = activeTarget?.command ?? "";

  const startOver = () => {
    setLocallyApproved(false);
    setCommandCopied(false);
    // On `/device` the ceremony came in on the URL, and "start over" means
    // possess another machine: drop the spent handle so the install
    // instructions come back instead of an empty card. The approval it
    // carried is finished or refused either way.
    if (autoLoadFromUrl && typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setLinkApproval(false);
    }
  };

  const copyCommand = async () => {
    setCommandCopied(true);
    try {
      await navigator.clipboard.writeText(displayedCommand);
      setCopyPulse(true);
      window.setTimeout(() => setCopyPulse(false), 1_500);
    } catch {
      setCopyPulse(false);
    }
  };

  return (
    <Card
      className={cn(
        "shadow-none",
        // Clipping is what keeps content inside the rounded corners of the
        // framed card. Frameless there is no border and no background to stay
        // inside, and the clip only ever reached something it should not: a
        // focus ring sits *outside* its input's box, so on a full-bleed field
        // it was sliced flat down both edges — the one affordance that says
        // "you are typing here", cut off.
        frameless ? "border-0 bg-transparent" : "overflow-hidden",
      )}
    >
      {frameless ? null : (
        <CardHeader>
          <CardTitle>Connect a host</CardTitle>
          <CardDescription>
            Install the daemon on a machine you control, then approve it from the link{" "}
            <code>spawnd possess</code> prints. It appears here once it&apos;s online.
          </CardDescription>
        </CardHeader>
      )}
      <CardContent className={cn("space-y-5", frameless && "p-0")}>
        {resumeApprovedHost || linkApproval !== false || locallyApproved ? null : (
          <section aria-labelledby="install-daemon-title" className="space-y-2">
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-muted-foreground" aria-hidden />
              <h3 id="install-daemon-title" className="text-sm font-medium">
                Install on {activeTarget?.label ?? "macOS / Linux"}
              </h3>
            </div>
            <div
              role="tablist"
              aria-label="Install target"
              className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1"
            >
              {targetRows.map((target) => {
                const selected = target.id === activeTarget?.id;
                return (
                  <Button
                    key={target.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    variant={selected ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8 flex-1 whitespace-nowrap px-2 text-xs"
                    onClick={() => {
                      setChosenTarget(target.id);
                      setCopyPulse(false);
                    }}
                  >
                    {target.label}
                  </Button>
                );
              })}
            </div>
            {/* One line, as it will be typed. Wrapping broke a shell pipeline
                across two rows mid-word on any narrow sheet, which reads as two
                commands and hides the copy button below the fold of the chip;
                the line scrolls sideways instead, the way the pressroom's own
                install chip does. */}
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted p-2">
              <span className="shrink-0 px-1 font-mono text-xs text-muted-foreground">
                {activeTarget?.prompt ?? "$"}
              </span>
              <code className="min-w-0 flex-1 overflow-x-auto px-1 py-1 font-mono text-xs leading-5 whitespace-nowrap">
                <span className="sr-only">
                  {activeTarget?.prompt === "PS>" ? "PowerShell command: " : "Terminal command: "}
                </span>
                {displayedCommand}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label="Copy install command"
                onClick={() => void copyCommand()}
              >
                {copyPulse ? (
                  <Check className="size-4 text-success" aria-hidden />
                ) : (
                  <Copy className="size-4" aria-hidden />
                )}
              </Button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              After installation, run <code>spawnd possess</code> on that machine.
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              Already running SPAWN D for another account on that machine? Run{" "}
              <code>spawnd possess --new-account</code> instead.
            </p>
          </section>
        )}

        {(showOnboardingProgress || showWaitingForMachine) &&
        resumeApprovedHost === null &&
        linkApproval === false &&
        !locallyApproved ? (
          <div className="h-px bg-border" />
        ) : null}

        {showOnboardingProgress ? (
          <SetupProgress progress={progress} elapsedMs={elapsedMs} stalledHint={stalledHint} />
        ) : showWaitingForMachine ? (
          <WaitingForMachine onlineHost={onlineHost} elapsedMs={elapsedMs} />
        ) : null}

        {resumeApprovedHost ? null : arrivalUnknown ? (
          // One tick, before the URL has been read. A spinner says "working";
          // any real layout here would be a guess shown to the reader.
          <div className="flex min-h-40 items-center justify-center px-6">
            <PaceBar className="w-full max-w-xs" label="Opening this approval…" />
          </div>
        ) : linkFormOwnsScreen ? (
          // Straight to the confirmation the link came here for. Where nothing
          // follows the approval it stays mounted and its "possessed" card is
          // the answer; where something does, `linkFormOwnsScreen` hands the
          // screen to the wait below rather than leaving a spent ceremony —
          // and a Done that empties it — as the only thing on the page.
          <HostApprovalForm
            autoLoadFromUrl
            onStartOver={startOver}
            onApproved={(hostName) => {
              setLocallyApproved(true);
              onPairingApproved?.(hostName);
            }}
          />
        ) : approvedAwaitingHost ? (
          // The longest wait in the whole flow, and it used to be a spinner the
          // size of a full stop on one checklist row. Everything else had just
          // unmounted — the approve card goes the moment the approval lands —
          // so the screen went quiet at exactly the point the reader most wants
          // to know something is still happening.
          <section className="space-y-3" aria-labelledby="connecting-title">
            <div className="space-y-1">
              <h3 id="connecting-title" className="text-sm font-medium">
                Connecting
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                Approved. The daemon is starting up and calling home — this usually takes a few
                seconds.
              </p>
            </div>
            <PaceBar className="w-full" label="Waiting for this machine to come online…" />
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The one milestone a spinner belongs on: the daemon coming online, which is
 * the only wait here that something else is working through.
 *
 * The two before it wait on the reader — copying the command, then running it
 * and approving from the link its terminal prints. A spinner on those claims
 * this page is busy when it is the person who has the next move, and the row
 * spins for as long as they take to make it.
 */
const WAITS_ON_THE_MACHINE = new Set<number>([3]);

function SetupProgress({
  progress,
  elapsedMs,
  stalledHint,
}: {
  progress: SetupProgressState;
  elapsedMs: number;
  stalledHint: string | null;
}) {
  return (
    <section className="space-y-3" aria-labelledby="setup-progress-title">
      <h3 id="setup-progress-title" className="text-sm font-medium">
        Setup progress
      </h3>
      <ol className="space-y-2" data-testid="setup-progress">
        {visibleSetupSteps(progress).map((step) => {
          const index = step - 1;
          const label = SETUP_PROGRESS_LABELS[index];
          const complete = progress.completed[index];
          const current = progress.current === step;
          return (
            <li
              key={label}
              className="flex items-center gap-2 text-sm"
              data-step={step}
              data-state={complete ? "complete" : current ? "current" : "pending"}
            >
              {complete ? (
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
              ) : current && WAITS_ON_THE_MACHINE.has(step) ? (
                // Genuinely working: something on the other machine has to
                // happen before this row can tick, and an empty ring reads the
                // same whether it is happening or not.
                <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : current ? (
                <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground/50" aria-hidden />
              )}
              <span className={complete ? "text-foreground" : "text-muted-foreground"}>
                {current ? SETUP_PROGRESS_ACTIVE_LABELS[index] : label}
              </span>
              {current && elapsedMs >= 30_000 && elapsedMs < 60_000 ? (
                <span className="ml-auto text-xs text-muted-foreground" role="status">
                  Still waiting…
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {stalledHint ? (
        <p className="text-xs leading-5 text-muted-foreground" data-testid="setup-stalled-hint">
          {stalledHint}
        </p>
      ) : null}
      {stalledHint ? <DoctorHint /> : null}
    </section>
  );
}

function WaitingForMachine({
  onlineHost,
  elapsedMs,
}: {
  onlineHost: Host | null;
  elapsedMs: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <StatusDot
          tone={onlineHost ? "active" : "waiting"}
          pulse={!onlineHost}
          label={onlineHost ? `${onlineHost.name} is online` : "Waiting for your machine"}
        />
        <span>{onlineHost ? `${onlineHost.name} is online.` : "Waiting for your machine…"}</span>
      </div>
      {!onlineHost && elapsedMs >= 30_000 && elapsedMs < 60_000 ? (
        <p className="text-xs text-muted-foreground" role="status">
          Still waiting…
        </p>
      ) : null}
      {!onlineHost && elapsedMs >= 60_000 ? (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-muted-foreground">
            Having trouble? Re-run the install command — it&apos;s safe to repeat.
          </p>
          <DoctorHint />
        </div>
      ) : null}
    </div>
  );
}

function PairingFailure({ failure }: { failure: keyof typeof PAIRING_FAILURE_COPY }) {
  return (
    <div
      className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
      data-testid="pairing-failure"
      role="alert"
    >
      <p className="text-sm font-medium">This machine was not approved</p>
      <p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">
        {PAIRING_FAILURE_COPY[failure]}
      </p>
      <DoctorHint />
    </div>
  );
}

/**
 * The one thing worth saying when a ceremony fails for a reason this page
 * cannot see.
 *
 * Everything above the failure happens on the reader's own machine — a daemon
 * that will not start, a service crash-looping against the wrong server, a
 * clock too far out to verify anything. The browser has no view of any of it,
 * so "something went wrong" is where its usefulness ends and `spawnd doctor`
 * begins. Naming the command turns a dead end into a next step.
 */
function DoctorHint({ className }: { className?: string }): JSX.Element {
  return (
    <p className={cn("text-xs leading-5 text-muted-foreground", className)}>
      Still stuck? Run <code className="font-mono">spawnd doctor</code> on that machine — it checks
      the daemon, its service, and the connection back here, and says what is wrong.
    </p>
  );
}

/**
 * Loads and approves a ceremony handed to this surface by the possession link.
 * Approval identifiers are never entered by hand here.
 */
export function HostApprovalForm({
  onApproved,
  autoLoadFromUrl = false,
  onStartOver,
}: {
  onApproved?: (hostName: string) => void;
  /**
   * Read `?ref=`/`?code=` and the `#k=` identity fragment from the URL and
   * load the pending approval on mount. Only the possession route (`/device`,
   * which the daemon's own link opens) arrives with those.
   */
  autoLoadFromUrl?: boolean;
  /**
   * The ceremony ended without trust and cannot be resumed — a fingerprint
   * mismatch, or a link this browser refused. The surface around this form owns
   * what "begin again" means (the plain install command), so it is told
   * rather than left showing an empty approval surface.
   */
  onStartOver?: () => void;
} = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  /**
   * Whether the URL carries a ceremony to load, which cannot be known until an
   * effect can read `window`. Unknown counts as present so the page does not
   * flash an empty state while it discovers a link-carried approval.
   */
  const [urlCeremony, setUrlCeremony] = useState<"unknown" | "present" | "absent">(
    autoLoadFromUrl ? "unknown" : "absent",
  );
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<keyof typeof PAIRING_FAILURE_COPY | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittingSince, setSubmittingSince] = useState<number | null>(null);
  const [submittingNow, setSubmittingNow] = useState(() => Date.now());
  const operationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // The identifier a successful review was loaded with, reused verbatim by
  // approve: the opaque URL ref or the older-server link's user_code.
  const [identifier, setIdentifier] = useState<{
    user_code?: string;
    approval_ref?: string;
  } | null>(null);
  // The out-of-band host key from the URL fragment; null → fingerprint fallback.
  const fragmentKeyRef = useRef<string | null>(null);
  // Terminal refusal (fragment mismatch / damaged link). Nothing was trusted.
  const [refusal, setRefusal] = useState<string | null>(null);
  // True once the pending host key equaled the fragment key exactly — the
  // invisible check passed, so the screen is a plain Approve confirmation.
  const [fragmentVerified, setFragmentVerified] = useState(false);
  // The operator said the fingerprints do not match. Terminal, like a refusal.
  const [stopped, setStopped] = useState(false);

  const beginOperation = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const started = Date.now();
    setSubmitting(true);
    setSubmittingSince(started);
    setSubmittingNow(started);
    return { operation, signal: controller.signal };
  };

  const operationIsCurrent = (operation: number) => operationRef.current === operation;

  useEffect(() => {
    if (submittingSince === null) return;
    const timer = window.setInterval(() => setSubmittingNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [submittingSince]);
  const submittingElapsed = submittingSince === null ? 0 : submittingNow - submittingSince;

  const resetCeremony = () => {
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSubmitting(false);
    setSubmittingSince(null);
    setPending(null);
    setFragmentVerified(false);
    setRefusal(null);
    fragmentKeyRef.current = null;
    setLocalPinState(null);
    setLocalPinCommitted(false);
    setStopped(false);
    setError(null);
    setFailure(null);
    setIdentifier(null);
    setHostName(null);
  };

  // Load the pending approval. Takes the opaque URL ref or the user_code from
  // an older-server link, and remembers which so approve reuses the exact same
  // identifier. The fragment check happens here, before anything is shown or
  // stored: the server-claimed key either exactly equals the out-of-band key or
  // the ceremony is refused.
  const review = async (id: { user_code?: string; approval_ref?: string }) => {
    const lookup = id.approval_ref
      ? { approval_ref: id.approval_ref }
      : { user_code: (id.user_code ?? "").trim().toUpperCase() };
    if (!lookup.approval_ref && !lookup.user_code) return;
    setError(null);
    setFailure(null);
    const { operation, signal } = beginOperation();
    try {
      const response = await auth.pendingDevice(lookup, signal);
      if (!operationIsCurrent(operation)) return;
      const expectedFingerprint = await ed25519PublicKeyFingerprint(response.host_public_key);
      if (!operationIsCurrent(operation)) return;
      if (response.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "The host's identity did not check out; nothing was trusted",
        );
      }
      // THE substitution check (docs/TRUST_DEVICE_MESH.md): the server's
      // claimed key against the key the host's own link carried out-of-band.
      // A hostile relay cannot pass this without controlling the terminal.
      const fragmentKey = fragmentKeyRef.current;
      if (fragmentKey !== null && response.host_public_key !== fragmentKey) {
        setRefusal(REFUSAL_MISMATCH);
        return;
      }
      if (!user) throw new ApprovalIdentityError("The authenticated account is unavailable");
      const existing = await loadBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: response.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      if (!operationIsCurrent(operation)) return;
      setFragmentVerified(fragmentKey !== null);
      setIdentifier(lookup);
      setPending(response);
      setLocalPinState(existing?.state ?? "new");
      setLocalPinCommitted(existing?.state === "active");
    } catch (caught) {
      if (!operationIsCurrent(operation) || signal.aborted) return;
      const knownFailure = pairingFailureCode(caught);
      if (knownFailure) {
        setFailure(knownFailure);
        return;
      }
      setError(
        caught instanceof ApiError || caught instanceof ApprovalIdentityError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Approval failed",
      );
    } finally {
      if (operationIsCurrent(operation)) {
        abortRef.current = null;
        setSubmitting(false);
        setSubmittingSince(null);
      }
    }
  };

  // The daemon opens the possession page with an opaque handle baked into the
  // URL (`/device?ref=…`, or `?code=…` from an older server) and its own host
  // key in the `#k=` fragment. Read both, then load once the account is known.
  const autoTriedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot guarded by a ref; review intentionally omitted
  useEffect(() => {
    if (!autoLoadFromUrl) return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    const urlCode = params.get("code");
    if (!(ref || urlCode)) {
      setUrlCeremony("absent");
      return;
    }
    setUrlCeremony("present");
    if (!user || autoTriedRef.current) return;
    autoTriedRef.current = true;
    const fragment = readFragmentHostKey(window.location.hash);
    if (fragment === "malformed") {
      // A present-but-broken identity check is refused, never downgraded to
      // the fingerprint fallback: the link was damaged, not merely old.
      setRefusal(REFUSAL_MALFORMED);
      return;
    }
    fragmentKeyRef.current = fragment;
    void review(ref ? { approval_ref: ref } : { user_code: urlCode ?? undefined });
  }, [user, autoLoadFromUrl]);

  const onApprove = async () => {
    if (!pending || !user || registration.data?.status !== "ready") return;
    setError(null);
    setFailure(null);
    const { operation, signal } = beginOperation();
    let localPinPersisted = false;
    try {
      if (identifier === null) {
        throw new ApprovalIdentityError(
          "No approval is loaded; open the link from the host's terminal again",
        );
      }
      const localIdentity = await loadBrowserDeviceIdentity(user.id);
      if (!operationIsCurrent(operation)) return;
      if (
        localIdentity === null ||
        localIdentity.publicKeyWire !== registration.data.device.public_key
      ) {
        throw new ApprovalIdentityError(
          "This browser's identity changed; refresh and start over on the host",
        );
      }
      // Defense in depth: re-assert the out-of-band binding at the moment of
      // signing, so no state shuffle can approve a key the fragment never
      // vouched for.
      if (fragmentKeyRef.current !== null && pending.host_public_key !== fragmentKeyRef.current) {
        throw new ApprovalIdentityError(
          "The host's identity no longer matches its link; nothing was trusted",
        );
      }
      const expectedFingerprint = await ed25519PublicKeyFingerprint(pending.host_public_key);
      if (!operationIsCurrent(operation)) return;
      if (pending.host_key_fingerprint !== expectedFingerprint) {
        throw new ApprovalIdentityError(
          "The host's identity changed mid-check; nothing was trusted",
        );
      }
      await approveBrowserHostPin({
        accountId: user.id,
        origin: browserHostPinServerOrigin(),
        hostPublicKey: pending.host_public_key,
        hostFingerprint: expectedFingerprint,
      });
      if (!operationIsCurrent(operation)) return;
      localPinPersisted = true;
      setLocalPinCommitted(true);
      setLocalPinState("active");
      const signature = await createHostPairApprovalProof(
        localIdentity,
        user.id,
        pending.approval_nonce,
        pending.host_public_key,
      );
      if (!operationIsCurrent(operation)) return;
      const browserKeyFingerprint = await ed25519PublicKeyFingerprint(
        registration.data.device.public_key,
      );
      if (!operationIsCurrent(operation)) return;
      const response = await auth.approveDevice(
        {
          ...identifier,
          approval_nonce: pending.approval_nonce,
          host_key_algorithm: pending.host_key_algorithm,
          host_public_key: pending.host_public_key,
          host_key_fingerprint: pending.host_key_fingerprint,
          browser_device_id: registration.data.device.id,
          browser_key_algorithm: registration.data.device.key_algorithm,
          browser_public_key: registration.data.device.public_key,
          // Derived locally from this browser's own key (mesh B5): the server
          // serves no fingerprint next to a key, so the wire copy the daemon
          // stores originates here, from the key holder.
          browser_key_fingerprint: browserKeyFingerprint,
          signature,
        },
        signal,
      );
      if (!operationIsCurrent(operation)) return;
      // The approve echo carries the keys alone (mesh B5); comparing them
      // byte-for-byte subsumes any fingerprint comparison.
      if (
        response.host_name !== pending.host_name ||
        response.approval_nonce !== pending.approval_nonce ||
        response.host_key_algorithm !== pending.host_key_algorithm ||
        response.host_public_key !== pending.host_public_key ||
        response.browser_device_id !== registration.data.device.id ||
        response.browser_key_algorithm !== registration.data.device.key_algorithm ||
        response.browser_public_key !== registration.data.device.public_key
      ) {
        throw new ApprovalIdentityError(
          "The approval response changed the reviewed host or browser identity",
        );
      }
      setHostName(response.host_name);
      onApproved?.(response.host_name);
      void seedApprovedHostBinding({
        accountId: user.id,
        hostPublicKey: pending.host_public_key,
        hostFingerprint: expectedFingerprint,
        knownHostId: response.host_id,
      });
      // Continuous gossip (mesh R7): the moment this device verifies a host,
      // it vouches the key to the account so its firsthand-known peers pin it
      // too. Best-effort — the background reconcile sweep republishes anything
      // this misses (e.g. a first pairing whose Host row is not created yet).
      if (response.host_id) {
        const publishTarget = {
          hostId: response.host_id,
          hostName: response.host_name,
          hostPublicKey: pending.host_public_key,
        };
        void (async () => {
          try {
            const signer = await loadBrowserDeviceIdentity(user.id);
            if (signer === null || registration.data?.status !== "ready") return;
            await publishHostIntroductionBroadcast({
              accountId: user.id,
              deviceId: registration.data.device.id,
              identity: signer,
              target: publishTarget,
            });
          } catch {
            // The sweep is the durable path.
          }
        })();
      }
      queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setPending(null);
      setLocalPinState(null);
      setLocalPinCommitted(false);
      setIdentifier(null);
    } catch (caught) {
      if (!operationIsCurrent(operation) || signal.aborted) return;
      const knownFailure = pairingFailureCode(caught);
      if (knownFailure) {
        setFailure(knownFailure);
        return;
      }
      const message =
        caught instanceof ApiError || caught instanceof ApprovalIdentityError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Approval failed";
      setError(
        localPinPersisted
          ? `The host's exact identity is saved in this browser, but the server step did not complete: ${message}. Retrying is safe.`
          : message,
      );
    } finally {
      if (operationIsCurrent(operation)) {
        abortRef.current = null;
        setSubmitting(false);
        setSubmittingSince(null);
      }
    }
  };

  const deviceLabel =
    registration.data?.status === "ready" ? (registration.data.device.label ?? null) : null;
  // Displayed fingerprint for this browser's own key, derived locally (mesh
  // B5) — the registration response carries the key alone.
  const readyBrowserKey =
    registration.data?.status === "ready" ? registration.data.device.public_key : null;
  const browserFingerprintQ = useQuery({
    queryKey: ["browser-key-fingerprint", readyBrowserKey],
    queryFn: () => ed25519PublicKeyFingerprint(readyBrowserKey as string),
    enabled: readyBrowserKey !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const browserFingerprint = readyBrowserKey === null ? null : (browserFingerprintQ.data ?? "…");

  // Derived from the key itself, never read off `host_key_fingerprint` in the
  // response (mesh B5). Shown as confirmation that this is the machine whose
  // terminal is waiting — not as a comparison chore: the `#k=` fragment
  // already proved the key, and asking twice would teach the habit of
  // approving whatever is put in front of you.
  const pendingHostKey = pending?.host_public_key ?? null;
  const hostFingerprintQ = useQuery({
    queryKey: ["pending-host-key-fingerprint", pendingHostKey],
    queryFn: () => ed25519PublicKeyFingerprint(pendingHostKey as string),
    enabled: pendingHostKey !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const hostFingerprint = pendingHostKey === null ? null : (hostFingerprintQ.data ?? "…");

  // A refusal is terminal: the identity check failed, nothing was trusted, and
  // there is deliberately no control here that proceeds anyway.
  if (refusal) {
    return (
      <div
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
        data-testid="possess-refusal"
      >
        <p className="text-sm font-medium text-foreground">This host could not be verified</p>
        <p className="text-sm leading-relaxed text-muted-foreground" role="alert">
          {refusal}
        </p>
        <DoctorHint />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            resetCeremony();
            onStartOver?.();
          }}
        >
          Start over
        </Button>
      </div>
    );
  }

  // Mirrors the app-wide ceremony vocabulary (docs/TRUST_UX.md): the shared
  // NumberCheck owns the compare/waiting/done/stopped screens, so host approval
  // reads exactly like every other identity check in the product.
  const checkPhase = stopped
    ? ("stopped" as const)
    : hostName
      ? ("done" as const)
      : submitting && pending
        ? ("waiting" as const)
        : pending
          ? ("compare" as const)
          : ("connecting" as const);
  // A server approval that failed AFTER the local pin landed needs a retry
  // surface, not the identity check again — that part already passed.
  const retryable = Boolean(error && localPinCommitted && pending);
  /**
   * Whether a ceremony this surface was handed is genuinely on its way.
   *
   * Inferring it from "we were handed one and have not got it yet" was wrong in
   * one important case: after `resetCeremony` — which is what "Close" does on
   * the mismatch screen, and "Start over" on a refusal — the handle is still
   * there and the result is gone again, but nothing is loading and nothing will
   * be, because the one-shot ref has already fired. That left a progress bar
   * captioned "Looking up that machine…" running for ever over a ceremony that
   * had been deliberately abandoned.
   *
   * So this asks whether an attempt is actually outstanding: the URL not yet
   * read, an attempt not yet made, or a request in flight right now.
   */
  const attemptOutstanding =
    urlCeremony === "unknown" || (urlCeremony === "present" && !autoTriedRef.current);
  const handedCeremonyLoading =
    !pending && !hostName && error === null && (attemptOutstanding || submitting);

  if (failure) return <PairingFailure failure={failure} />;
  if (!pending && !hostName && !handedCeremonyLoading && error === null) return null;

  return (
    <div className="space-y-3">
      {handedCeremonyLoading ? (
        // The link's ceremony is on its way. There is nothing to type or
        // confirm yet, so the only honest thing to show is that lookup.
        <div
          className="flex min-h-32 items-center justify-center px-6"
          data-testid="pairing-loading"
        >
          <PaceBar className="w-full max-w-xs" label="Looking up that machine…" />
        </div>
      ) : null}

      {error && !retryable && (
        <div className="space-y-1.5">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
          <DoctorHint />
        </div>
      )}
      {submitting && !pending && submittingElapsed >= 30_000 ? (
        <div className="flex flex-wrap items-center justify-between gap-2" role="status">
          <p className="text-xs text-muted-foreground">Still waiting…</p>
          {submittingElapsed >= 60_000 ? (
            <Button type="button" variant="ghost" size="sm" onClick={resetCeremony}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {registration.isError && (
        <p className="text-sm text-destructive" role="alert">
          This browser&apos;s identity registration failed, so it cannot approve hosts. Reload to
          retry.
        </p>
      )}
      {registration.data && registration.data.status !== "ready" && (
        <p className="text-sm text-destructive" role="alert">
          This browser&apos;s identity is {registration.data.status.replace("_", " ")}, so it cannot
          approve hosts.
        </p>
      )}
      {submitting && pending && (fragmentVerified || retryable) && submittingElapsed >= 30_000 ? (
        <div className="flex flex-wrap items-center justify-between gap-2" role="status">
          <p className="text-xs text-muted-foreground">
            Taking a while? Make sure the machine is still open.
          </p>
          {submittingElapsed >= 60_000 ? (
            <Button type="button" variant="ghost" size="sm" onClick={resetCeremony}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {retryable ? (
        // The local pin already landed and only the server step failed. The
        // identity check has passed, so re-running it would be theatre — offer
        // the retry directly instead of sending the operator round again.
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              className="flex-1"
              disabled={submitting}
              onClick={() => void onApprove()}
            >
              {submitting ? "Retrying…" : "Retry"}
            </Button>
            <Button type="button" variant="outline" disabled={submitting} onClick={resetCeremony}>
              Cancel
            </Button>
          </div>
        </div>
      ) : pending && fragmentVerified && !hostName ? (
        // The link from the host's own terminal carried its identity key, and
        // it matched exactly. The human check is already done, so asking for a
        // fingerprint comparison here would be theatre.
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1" data-testid="possess-approve-screen">
            <p className="text-sm font-medium">
              Approve <code>{pending.host_name}</code>
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              This browser verified the host&apos;s identity against the link from its terminal.
              Approving grants all your devices access to it.
            </p>
          </div>
          {localPinState === "active" && (
            <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
              This exact host key is already active in this browser. Approving again only completes
              the server side.
            </p>
          )}
          {localPinState === "revoked" && (
            <p className="text-xs text-destructive" data-testid="local-pin-state">
              You previously removed this host key. Approving deliberately trusts the same key
              again.
            </p>
          )}
          {localPinState === "new" && (
            <p className="text-xs text-muted-foreground" data-testid="local-pin-state">
              Approval saves this host key in this browser before registering it with the server.
            </p>
          )}
          {localPinCommitted && (
            <p className="text-xs font-medium text-foreground" role="status">
              Host key saved locally. Retrying the server approval is safe.
            </p>
          )}
          <div className="space-y-1 border-t border-border pt-2">
            <p className="text-xs text-muted-foreground">Host key, verified against the link:</p>
            <p
              className="break-all font-mono text-xs text-foreground"
              data-testid="pending-host-fingerprint"
            >
              {hostFingerprint ?? "unavailable"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Approving as{deviceLabel ? ` ${deviceLabel},` : ""} this browser&apos;s key:
            </p>
            <p
              className="break-all font-mono text-xs text-muted-foreground"
              data-testid="browser-key-fingerprint"
            >
              {/* Derived locally from the key this browser holds (mesh B5). */}
              {browserFingerprint ?? "unavailable"}
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 @sm/settings:flex-row">
            <Button type="button" variant="outline" disabled={submitting} onClick={resetCeremony}>
              Cancel
            </Button>
            <Button
              type="button"
              className="flex-1"
              data-testid="possess-approve"
              disabled={submitting || registration.data?.status !== "ready"}
              onClick={onApprove}
            >
              {/* One label whatever the pin's history: the line above already
                  says if this key was removed before, and the possess screen
                  reads the same every time you land on it. */}
              {submitting
                ? "Approving…"
                : localPinCommitted
                  ? "Retry server approval"
                  : `Approve ${pending.host_name}`}
            </Button>
          </div>
        </div>
      ) : pending || hostName ? (
        // No fragment (an older link): the human compares the full fingerprint.
        // Also owns the done/stopped screens, so a fragment-verified approval
        // lands here once hostName is set.
        <>
          {/* NumberCheck deliberately shows no host name — it is one shared
              ceremony surface. Name the host above it so the operator knows
              what they are vouching for. Not rendered on the fragment path,
              where the approve screen already names it. */}
          {pending && !hostName && !stopped && (
            <div className="text-center">
              <p className="text-sm text-muted-foreground">Possess a host</p>
              <p className="text-xl font-semibold text-foreground">{pending.host_name}</p>
            </div>
          )}
          <NumberCheck
            phase={checkPhase}
            mode="enter"
            fingerprint={pending?.host_key_fingerprint}
            slowHint={submitting && submittingElapsed >= 30_000}
            waitingEscape={submitting && submittingElapsed >= 60_000}
            otherScreen="in the host's terminal"
            doneText={`${hostName} is possessed. All your devices can reach it.`}
            stoppedText="The fingerprints don't match, so nothing was trusted. Start over from the host's terminal."
            onMatch={() => void onApprove()}
            onNoMatch={() => {
              // A fingerprint mismatch is terminal — never a retry loop.
              setStopped(true);
            }}
            onDone={() => {
              resetCeremony();
              // Done on a possessed card means "possess another one". With
              // nothing left to type, that is the surface's job: hand back so
              // it shows the install command again rather than nothing.
              onStartOver?.();
            }}
            onClose={() => {
              resetCeremony();
              // A mismatch is terminal: the approval it refused is spent. Hand
              // back to the surface, which starts the whole thing again.
              onStartOver?.();
            }}
          />
        </>
      ) : null}
    </div>
  );
}
