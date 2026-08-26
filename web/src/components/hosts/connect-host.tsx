"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, Circle, Copy, KeyRound, Loader2, Terminal } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useMemo, useRef, useState } from "react";
import { NumberCheck } from "@/components/access/number-check";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaceBar } from "@/components/ui/pace-bar";
import { StatusDot } from "@/components/ui/status";
import { subscribeToTrustEvents } from "@/lib/alert-socket";
import {
  ApiError,
  auth,
  type DevicePendingApproval,
  type Host,
  hosts,
  type SetupClaim,
  type SetupClaimMint,
  setupClaims,
} from "@/lib/api";
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
import { detectPlatform, setupInstallCommand, UNDETECTED_PLATFORM } from "@/lib/platform";
import {
  deriveSetupChecklist,
  SETUP_CHECKLIST_ACTIVE_LABELS,
  SETUP_CHECKLIST_LABELS,
  setupChecklistStalledHint,
} from "@/lib/setup-claims";
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
 * Returns the wire-encoded key, `null` when the URL carries no `k` fragment
 * (an older daemon, a retyped URL — the fingerprint-compare fallback), or
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
  /** Forwarded to {@link PairingCodeForm}: read the possession handle and the
   * `#k=` identity fragment from the URL. Only `/device` sets this. */
  autoLoadFromUrl?: boolean;
  /** `/device` approves a ceremony it was handed; onboarding and Add a
   * machine mint attended setup claims. */
  mintSetupClaim?: boolean;
  /** An approval completed before this surface mounted, but its daemon has not
   * connected yet. Resume at Approved instead of teaching installation again. */
  resumeApprovedHost?: Host | null;
}): JSX.Element {
  const {
    onHostOnline,
    onPairingApproved,
    frameless = false,
    autoLoadFromUrl = false,
    mintSetupClaim = !autoLoadFromUrl,
    resumeApprovedHost = null,
  } = props;
  const { user } = useAuth();
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [copyPulse, setCopyPulse] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [minted, setMinted] = useState<SetupClaimMint | null>(null);
  const [claimSupport, setClaimSupport] = useState<
    "idle" | "loading" | "supported" | "unsupported" | "error"
  >("idle");
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintAttempt, setMintAttempt] = useState(0);
  const [locallyApproved, setLocallyApproved] = useState(false);
  /**
   * True when this visit arrived holding a specific approval — `?ref=`/`?code=`
   * from the link `spawnd possess` printed.
   *
   * Everything above the approve card exists to *get* a ceremony started:
   * install the daemon, wait for it to register, type its code. Arriving by
   * link, all of that is already done, and showing it turns a one-click
   * confirmation into a page of instructions for work the reader has finished.
   * Derived from the URL rather than the prop so a bare `/device` still offers
   * the code field.
   */
  /**
   * Whether the typed-code fallback is showing.
   *
   * Opened by hand, and stays open once opened — someone who went looking for
   * it is mid-way through using it, and folding it back up under them as the
   * claim advances would take the field away while they typed.
   */
  const [codeEntryOpen, setCodeEntryOpen] = useState(false);
  const [linkApproval, setLinkApproval] = useState<boolean | "unknown">(
    // Unknown until the URL can be read, which is an effect — `window` is not
    // there during the server render. Guessing "no" for that tick paints the
    // install-and-type-a-code layout and replaces it a frame later: a flash of
    // exactly the screen a link exists to skip.
    autoLoadFromUrl ? "unknown" : false,
  );

  useEffect(() => {
    if (!autoLoadFromUrl) return;
    const params = new URLSearchParams(window.location.search);
    setLinkApproval(Boolean(params.get("ref") ?? params.get("code")));
  }, [autoLoadFromUrl]);

  /** The confirm-only layout, which lasts exactly as long as the question does. */
  const showLinkConfirm = linkApproval !== false && !locallyApproved;
  /** Nothing can be laid out yet without knowing how this visit arrived. */
  const arrivalUnknown = linkApproval === "unknown";
  const [now, setNow] = useState(() => Date.now());
  const notifiedRef = useRef(false);
  const initialOnlineIdsRef = useRef<Set<string> | null>(null);
  const progressStartedAtRef = useRef(Date.now());
  const hostsQ = useQuery({
    // The same cache lane the surrounding page derives its step from, on
    // purpose. This used to be a private lane so the checklist could tick
    // Online before the parent moved on — but the parent now polls hosts for
    // itself (so a reload after an approval is not stranded on "connect your
    // first host"), and two independent 3 s polls race: the parent could learn
    // the host was online a full interval before this checklist did, and
    // replace the screen while the last row still read Connecting.
    //
    // One lane, one answer: both see the host in the same render, so the row
    // ticks over as the parent starts its success beat rather than after it.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: mintAttempt is an explicit retry/remint trigger
  useEffect(() => {
    if (!mintSetupClaim || !user) {
      setClaimSupport("idle");
      setMinted(null);
      return;
    }
    let cancelled = false;
    setClaimSupport("loading");
    setMintError(null);
    setMinted(null);
    void setupClaims
      .mint()
      .then((response) => {
        if (cancelled) return;
        setMinted(response);
        setClaimSupport("supported");
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && (caught.status === 404 || caught.status === 405)) {
          setClaimSupport("unsupported");
          return;
        }
        setClaimSupport("error");
        setMintError(
          caught instanceof Error ? caught.message : "Live setup progress is unavailable",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [mintAttempt, mintSetupClaim, user]);

  // A visible setup surface must never leave an expired token in the command.
  // Hidden tabs pause the timer and re-check immediately when shown again.
  useEffect(() => {
    if (!minted) return;
    let timer: number | null = null;
    const expiration = Date.parse(minted.expires_at);
    const remint = () => setMintAttempt((value) => value + 1);
    const arm = () => {
      if (document.hidden || !Number.isFinite(expiration)) return;
      const remaining = expiration - Date.now();
      if (remaining <= 0) {
        remint();
        return;
      }
      timer = window.setTimeout(remint, remaining);
    };
    const onVisibility = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (!document.hidden) arm();
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [minted]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new token starts a fresh visible checklist
  useEffect(() => {
    setCommandCopied(false);
    setLocallyApproved(false);
  }, [minted?.token]);

  const claimQ = useQuery({
    queryKey: ["setup-claim", minted?.token ?? null],
    queryFn: () => setupClaims.get(minted?.token as string),
    enabled: claimSupport === "supported" && minted !== null,
    retry: (count, caught) =>
      !(caught instanceof ApiError && (caught.status === 404 || caught.status === 405)) &&
      count < 2,
    refetchInterval: () => (typeof document !== "undefined" && document.hidden ? false : 2_000),
  });
  const claim = claimQ.data ?? null;

  useEffect(() => {
    if (!minted) return;
    return subscribeToTrustEvents((event) => {
      if (event.event !== "host.pair_requested" && event.event !== "host.pair_resolved") return;
      if (claim?.approval_ref && event.approval_ref !== claim.approval_ref) return;
      void claimQ.refetch();
    });
  }, [claim?.approval_ref, claimQ.refetch, minted]);

  const onlineHost = useMemo(() => {
    const listed = hostsQ.data ?? [];
    if (resumeApprovedHost) {
      return (
        listed.find((host) => host.id === resumeApprovedHost.id && host.status === "online") ?? null
      );
    }
    if (claim?.host_id) {
      const claimed = listed.find((host) => host.id === claim.host_id);
      // Only pin on the claim's host while that host still exists. A ceremony
      // run on a machine this account had already possessed registers a second
      // host, binds the claim to it, and the daemon drops it again on adopting
      // the instance it already had — leaving the claim naming a host that is
      // gone. Waiting on it would never end, so fall through and let the
      // general detection below find the machine that is actually here.
      if (claimed) return claimed.status === "online" ? claimed : null;
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
  }, [claim?.host_id, hostsQ.data, resumeApprovedHost, locallyApproved]);

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

  const checklist = deriveSetupChecklist({
    copied: commandCopied,
    claim,
    locallyApproved: locallyApproved || resumeApprovedHost !== null,
    hostOnline: onlineHost !== null,
  });
  const progressKey = `${minted?.token ?? "fallback"}:${checklist.completedThrough}:${checklist.failed ?? "ok"}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: progressKey intentionally resets elapsed time on a milestone transition
  useEffect(() => {
    progressStartedAtRef.current = Date.now();
    setNow(Date.now());
  }, [progressKey]);
  useEffect(() => {
    if (checklist.completedThrough === 4 || checklist.failed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [checklist.completedThrough, checklist.failed]);
  const elapsedMs = now - progressStartedAtRef.current;
  const stalledHint = setupChecklistStalledHint(checklist, elapsedMs);
  /**
   * Whether the machine has reached this account, which is the moment the
   * install half of this screen stops being useful.
   *
   * Until then the command is the whole point. After it, "install on macOS",
   * the command itself, and "after installation, run spawnd possess" are all
   * instructions for work the reader has visibly finished — and they were
   * pushing the one thing left to do, the fingerprint, below the fold.
   */
  const machineHasArrived =
    claim?.status === "ready" || claim?.status === "approved" || locallyApproved;

  /**
   * Whether the waiting pill has anything true to say.
   *
   * It is the fallback for surfaces with no live checklist, and it used to
   * render unconditionally — which put it in two places it was wrong. On a bare
   * `/device`, where nothing has been started and the reader is being asked to
   * type a code, it claimed a ceremony that did not exist above the field for
   * starting one. And after an approval it sat pulsing "Waiting for your
   * machine…" directly above this surface's own card saying that machine is
   * possessed and every device can reach it — two answers to one question, on
   * one screen, disagreeing.
   *
   * So: only while something is genuinely on its way, and only while nothing
   * else here has already reported the outcome. Once the approval lands, the
   * confirmation card owns the screen.
   */
  /**
   * Approved here, and the machine has not appeared yet.
   *
   * This is its own state rather than an absence of one: the approve card
   * unmounts the instant an approval lands, so without something to take its
   * place the surface simply emptied out while the daemon was still starting.
   */
  const approvedAwaitingHost =
    (locallyApproved || claim?.status === "approved") && onlineHost === null;
  const waitingForAMachine =
    !locallyApproved && (resumeApprovedHost !== null || claim !== null || commandCopied);

  const platformName =
    platform.os === "macos"
      ? "macOS"
      : platform.os === "linux"
        ? "Linux"
        : platform.os === "windows"
          ? "Windows"
          : "your machine";
  const displayedCommand =
    minted && typeof window !== "undefined"
      ? setupInstallCommand(window.location.origin, minted.token)
      : platform.installCommand;
  const copyDisabled = claimSupport === "loading";

  /**
   * Back to the beginning: a new setup claim, a new command, an empty
   * checklist.
   *
   * The claim a refused ceremony was bound to is spent — it named one machine
   * and that machine was not vouched for — so resuming it would offer to
   * approve the thing just rejected. Minting a fresh one is what makes "start
   * over" mean the start, rather than an empty code box under a dead approval.
   */
  const startOver = () => {
    setLocallyApproved(false);
    setCommandCopied(false);
    setCodeEntryOpen(false);
    setMintAttempt((attempt) => attempt + 1);
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
            Install the daemon on the machine where your sessions should run, then approve it from
            the link its terminal prints.
          </CardDescription>
        </CardHeader>
      )}
      <CardContent className={cn("space-y-5", frameless && "p-0")}>
        {resumeApprovedHost || linkApproval !== false || machineHasArrived ? null : (
          <section aria-labelledby="install-daemon-title" className="space-y-2">
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-muted-foreground" aria-hidden />
              <h3 id="install-daemon-title" className="text-sm font-medium">
                Install on {platformName}
              </h3>
            </div>
            {/* Wrapped, not clipped. `whitespace-nowrap` with `overflow-x-auto`
                cut the command off mid-token behind the copy button and offered
                no scrollbar to find the rest of it — so the one thing on screen
                the reader has to trust was unreadable, and a setup token is
                exactly the part that fell off the end. */}
            <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted p-2">
              <code className="min-w-0 flex-1 px-1 py-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                {displayedCommand}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label="Copy install command"
                disabled={copyDisabled}
                onClick={() => void copyCommand()}
              >
                {claimSupport === "loading" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : copyPulse ? (
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
              Already running SPAWN D for another account on that machine? Add{" "}
              <code>--new-account</code>.
            </p>
            {mintError && (
              <p className="text-xs leading-5 text-muted-foreground" role="status">
                Live setup progress could not start ({mintError}). The install command still works.
              </p>
            )}
          </section>
        )}

        {resumeApprovedHost || linkApproval !== false || machineHasArrived ? null : (
          <div className="h-px bg-border" />
        )}

        {showLinkConfirm ? null : resumeApprovedHost ? (
          <SetupChecklist
            claim={null}
            completedThrough={checklist.completedThrough}
            elapsedMs={elapsedMs}
            stalledHint={stalledHint}
          />
        ) : claimSupport === "supported" && minted ? (
          <SetupChecklist
            claim={claim}
            completedThrough={checklist.completedThrough}
            elapsedMs={elapsedMs}
            stalledHint={stalledHint}
          />
        ) : waitingForAMachine ? (
          <LegacyWaitingState
            onlineHost={onlineHost}
            elapsedMs={elapsedMs}
            onRetryClaims={
              claimSupport === "error" ? () => setMintAttempt((value) => value + 1) : undefined
            }
          />
        ) : null}

        {resumeApprovedHost ? null : arrivalUnknown ? (
          // One tick, before the URL has been read. A spinner says "working";
          // any real layout here would be a guess shown to the reader.
          <div className="flex min-h-40 items-center justify-center px-6">
            <PaceBar className="w-full max-w-xs" label="Opening this approval…" />
          </div>
        ) : linkApproval ? (
          // Straight to the confirmation the link came here for. It stays
          // mounted after approval: the form's own "possessed" card is the
          // confirmation, and unmounting it would replace the answer with an
          // empty code box. `locallyApproved` brings the progress view back
          // above it rather than swapping this out.
          <PairingCodeForm
            autoLoadFromUrl
            onStartOver={startOver}
            onApproved={(hostName) => {
              setLocallyApproved(true);
              onPairingApproved?.(hostName);
            }}
          />
        ) : claim?.status === "failed" && claim.error ? (
          <PairingFailure failure={claim.error} />
        ) : approvedAwaitingHost ? (
          // The longest wait in the whole flow, and it used to be a spinner the
          // size of a full stop on one checklist row. Everything else had just
          // unmounted — the approve card goes the moment the approval lands —
          // so the screen went quiet at exactly the point the reader most wants
          // to know something is still happening.
          //
          // It also sits ahead of the "ready" branch below on purpose: the
          // claim stays `ready` until the next poll confirms the approval, and
          // rendering the approve card again in that window flashed a pairing
          // code field over an approval already given.
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
        ) : claim?.status === "ready" && claim.approval_ref ? (
          <section className="space-y-3" aria-labelledby="inline-approve-title">
            <div className="space-y-1">
              <h3 id="inline-approve-title" className="text-sm font-medium">
                Approve this machine
              </h3>
              {/* A claim only reaches "ready" when a ceremony presented this
               * screen's own setup token, so the machine is one this reader
               * ran a command on and its terminal is showing this same
               * fingerprint — not a link to open. Naming a link sent them
               * hunting for one the terminal no longer prints. */}
              <p className="text-xs leading-5 text-muted-foreground">
                The terminal you ran the command in is showing a key. Check it matches the one
                below, then approve.
              </p>
            </div>
            <PairingCodeForm
              approvalRef={claim.approval_ref}
              inlineReview
              onStartOver={startOver}
              onApproved={(hostName) => {
                setLocallyApproved(true);
                onPairingApproved?.(hostName);
                void claimQ.refetch();
              }}
            />
          </section>
        ) : claim?.status === "approved" || locallyApproved ? null : (
          <>
            <div className="h-px bg-border" />

            {/* The fallback, folded away. Typing a code is what you do when you
                cannot open the link the terminal prints — a real path, and a
                rare one. Open, it put a heading, a labelled field, a paragraph
                and a button between the reader and the thing they are actually
                waiting on, for a route most of them will never take. */}
            <section aria-labelledby="pair-host-title" className="space-y-3">
              {codeEntryOpen ? (
                <>
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                    <h3 id="pair-host-title" className="text-sm font-medium">
                      Enter a pairing code
                    </h3>
                  </div>
                  <PairingCodeForm
                    autoLoadFromUrl={autoLoadFromUrl}
                    onStartOver={startOver}
                    onApproved={onPairingApproved}
                  />
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  // The press sheet sets every button in small caps, which is
                  // right for a two-word verb and wrong for a sentence — a
                  // whole line of it stops reading as a control and starts
                  // reading as a heading nobody can click.
                  className="w-full normal-case tracking-normal [font-family:inherit] [font-size:0.8125rem]"
                  onClick={() => setCodeEntryOpen(true)}
                  data-testid="reveal-pairing-code"
                >
                  <KeyRound className="size-3.5" aria-hidden />
                  Enter a pairing code instead
                </Button>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The milestones a spinner belongs on: the ones spent waiting for the machine
 * to register, and for it to come online.
 *
 * The other two wait on the reader — copying the command, and answering the
 * fingerprint question right below the list. A spinner there claims the page
 * is busy when the page is waiting on them, so they wait back at it.
 */
const WAITS_ON_THE_MACHINE = new Set<number>([2, 4]);

function SetupChecklist({
  claim,
  completedThrough,
  elapsedMs,
  stalledHint,
}: {
  claim: SetupClaim | null;
  completedThrough: 0 | 1 | 2 | 3 | 4;
  elapsedMs: number;
  stalledHint: string | null;
}) {
  return (
    <section className="space-y-3" aria-labelledby="setup-progress-title">
      <h3 id="setup-progress-title" className="text-sm font-medium">
        Setup progress
      </h3>
      <ol className="space-y-2" data-testid="setup-checklist">
        {SETUP_CHECKLIST_LABELS.map((label, index) => {
          const step = (index + 1) as 1 | 2 | 3 | 4;
          const complete = completedThrough >= step;
          const current = !complete && completedThrough + 1 === step;
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
                {current ? SETUP_CHECKLIST_ACTIVE_LABELS[index] : label}
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
      {/* Past the approval and still nothing: whatever is wrong is on the other
          machine, where this page cannot look. That is exactly the stall a
          crash-looping daemon service produces — approved, never online — and
          it is invisible from here. */}
      {stalledHint && completedThrough >= 3 ? <DoctorHint /> : null}
      {claim?.host_name && claim.status !== "pending" ? (
        <p className="text-xs text-muted-foreground" role="status">
          {claim.host_name} registered{claim.os ? ` · ${claim.os}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function LegacyWaitingState({
  onlineHost,
  elapsedMs,
  onRetryClaims,
}: {
  onlineHost: Host | null;
  elapsedMs: number;
  onRetryClaims?: () => void;
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs leading-5 text-muted-foreground">
            Having trouble? Re-run the install command — it&apos;s safe to repeat.
          </p>
          {onRetryClaims ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetryClaims}>
              Retry live progress
            </Button>
          ) : null}
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

export function PairingCodeForm({
  onApproved,
  autoLoadFromUrl = false,
  approvalRef = null,
  inlineReview = false,
  onStartOver,
}: {
  onApproved?: (hostName: string) => void;
  /**
   * Read `?ref=`/`?code=` and the `#k=` identity fragment from the URL and
   * load the pending approval on mount. Only the possession route (`/device`,
   * which the daemon's own link opens) arrives with those; the Settings and
   * onboarding embeddings type a code by hand and leave this off.
   */
  autoLoadFromUrl?: boolean;
  /** Setup-claim inline review. It has no `#k=` channel, so this deliberately
   * enters the full-fingerprint compare frame. */
  approvalRef?: string | null;
  /** Keep the typed-code fallback below the claim-fed review card. */
  inlineReview?: boolean;
  /**
   * The ceremony ended without trust and cannot be resumed — a fingerprint
   * mismatch, or a link this browser refused. The surface around this form owns
   * what "begin again" means (a fresh claim, a fresh command), so it is told
   * rather than left showing a code box for an approval that is now void.
   */
  onStartOver?: () => void;
} = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const [code, setCode] = useState("");
  /**
   * Whether the URL carries a ceremony to load, which cannot be known until an
   * effect can read `window`. Unknown counts as present: showing an empty code
   * box for that tick asks the reader to type something the page is already
   * fetching, and then takes the question away again.
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
  // approve: the opaque URL ref (auto-open path) or the typed user_code.
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
    setCode("");
  };

  // Load the pending approval. Takes the opaque URL ref the terminal
  // opened/printed or the typed user_code, and remembers which, so approve
  // reuses the exact same identifier. The fragment check happens here, before
  // anything is shown or stored: the server-claimed key either exactly equals
  // the out-of-band key or the ceremony is refused.
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

  const onReview = async (event: FormEvent) => {
    event.preventDefault();
    await review({ user_code: code });
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

  const approvalRefTriedRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: review is the ceremony operation; the ref makes this one-shot per approval_ref
  useEffect(() => {
    if (!approvalRef || !user || approvalRefTriedRef.current === approvalRef) return;
    approvalRefTriedRef.current = approvalRef;
    fragmentKeyRef.current = null;
    void review({ approval_ref: approvalRef });
  }, [approvalRef, user]);

  const onApprove = async () => {
    if (!pending || !user || registration.data?.status !== "ready") return;
    setError(null);
    setFailure(null);
    const { operation, signal } = beginOperation();
    let localPinPersisted = false;
    try {
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
          ...(identifier ?? { user_code: code.trim().toUpperCase() }),
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
      setCode("");
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
  // NumberCheck owns the compare/waiting/done/stopped screens, so the possess
  // fallback reads exactly like every other identity check in the product.
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
    urlCeremony === "unknown" ||
    (urlCeremony === "present" && !autoTriedRef.current) ||
    (approvalRef != null && approvalRefTriedRef.current !== approvalRef);
  // An error drops out of this so the typed-code fallback is always reachable
  // when the load does not work.
  const handedCeremonyLoading =
    !pending && !hostName && error === null && (attemptOutstanding || submitting);

  if (failure) return <PairingFailure failure={failure} />;

  return (
    <form className="space-y-3" onSubmit={onReview}>
      {/* The field is for starting a ceremony by hand. Once one is loaded —
          typed in, fed by a claim, or carried by the link — it is answered
          below, and an empty box above the answer just invites re-entering it.
          A bare page, or one whose auto-load was refused, still shows it so
          there is always a way in. */}
      {handedCeremonyLoading ? (
        // A ceremony was handed to this surface — by the link, or by a bound
        // setup claim — and is on its way. There is nothing to type and
        // nothing to confirm yet, so the only honest thing to show is that
        // something is happening.
        <div
          className="flex min-h-32 items-center justify-center px-6"
          data-testid="pairing-loading"
        >
          <PaceBar className="w-full max-w-xs" label="Looking up that machine…" />
        </div>
      ) : (!inlineReview && !autoLoadFromUrl) || (!pending && !hostName) ? (
        <div className="space-y-1.5">
          <Label htmlFor={inlineReview ? "inline-host-pairing-code" : "host-pairing-code"}>
            Code from the terminal
          </Label>
          <Input
            id={inlineReview ? "inline-host-pairing-code" : "host-pairing-code"}
            placeholder="QZ4K-7HMT"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
              setPending(null);
              setLocalPinState(null);
              setLocalPinCommitted(false);
              setHostName(null);
            }}
            required
            disabled={pending !== null}
          />
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
            <p className="text-xs text-muted-foreground">Its terminal printed this host key:</p>
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
        // No fragment (an older daemon, or a retyped link): the human compares
        // the full fingerprint. Also owns the done/stopped screens, so a
        // fragment-verified approval lands here once hostName is set.
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
            compact={inlineReview}
            phase={checkPhase}
            mode="enter"
            fingerprint={pending?.host_key_fingerprint}
            fingerprintHelp={
              inlineReview
                ? "Compare this full fingerprint against the one shown in the machine's terminal."
                : undefined
            }
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
            onDone={resetCeremony}
            onClose={() => {
              resetCeremony();
              // A mismatch is terminal: the approval it refused is spent, and
              // dropping the reader on an empty code field asks them to
              // re-enter a code for a ceremony that no longer exists. Hand back
              // to the surface, which starts the whole thing again.
              onStartOver?.();
            }}
          />
          {inlineReview && pending && !hostName && !stopped ? (
            // A rarely-needed escape, sized like one. As a full-width button it
            // was the third identical bar in a stack, competing with the action
            // this screen exists for.
            <div className="flex justify-center">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="text-muted-foreground"
                onClick={resetCeremony}
              >
                Enter a pairing code instead
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="space-y-3" data-testid="possess-instructions">
          <p className="text-xs leading-5 text-muted-foreground">
            Run <code>spawnd possess</code> on that machine. Its terminal opens this approval in
            your browser, and the link carries the host&apos;s identity — so finishing is a single
            click. Typing a code is the fallback for when you cannot open that link (a remote host,
            or a browser on another device).
          </p>
          <Button type="submit" className="w-full" disabled={submitting || !code.trim()}>
            {submitting ? "Checking…" : "Look up host"}
          </Button>
        </div>
      )}
    </form>
  );
}
