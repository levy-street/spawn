"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Terminal } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useRef, useState } from "react";
import { NumberCheck } from "@/components/access/number-check";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status";
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
import { detectPlatform, UNDETECTED_PLATFORM } from "@/lib/platform";
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
  /** Drop the card chrome and its heading: the host is already inside a framed,
   * titled surface (the onboarding sheet) and a second frame just doubles it. */
  frameless?: boolean;
  /** Forwarded to {@link PairingCodeForm}: read the possession handle and the
   * `#k=` identity fragment from the URL. Only `/device` sets this. */
  autoLoadFromUrl?: boolean;
}): JSX.Element {
  const { onHostOnline, frameless = false, autoLoadFromUrl = false } = props;
  const [platform, setPlatform] = useState(UNDETECTED_PLATFORM);
  const [copied, setCopied] = useState(false);
  const notifiedRef = useRef(false);
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    refetchInterval: 3_000,
  });
  const onlineHost = hostsQ.data?.find((host) => host.status === "online");

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    if (!onlineHost || notifiedRef.current) return;
    notifiedRef.current = true;
    onHostOnline?.(onlineHost);
  }, [onlineHost, onHostOnline]);

  const platformName =
    platform.os === "macos"
      ? "macOS"
      : platform.os === "linux"
        ? "Linux"
        : platform.os === "windows"
          ? "Windows"
          : "your machine";

  return (
    <Card className={cn("overflow-hidden shadow-none", frameless && "border-0 bg-transparent")}>
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
        <section aria-labelledby="install-daemon-title" className="space-y-2">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" aria-hidden />
            <h3 id="install-daemon-title" className="text-sm font-medium">
              Install on {platformName}
            </h3>
          </div>
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted p-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-xs">
              {platform.installCommand}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Copy install command"
              onClick={async () => {
                await navigator.clipboard.writeText(platform.installCommand);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              }}
            >
              {copied ? (
                <Check className="size-4 text-success" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            After installation, run <code>spawnd possess</code> on that machine.
          </p>
        </section>

        <div className="h-px bg-border" />

        <section aria-labelledby="pair-host-title" className="space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            <h3 id="pair-host-title" className="text-sm font-medium">
              Enter a pairing code
            </h3>
          </div>
          <PairingCodeForm autoLoadFromUrl={autoLoadFromUrl} />
        </section>

        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
          <StatusDot
            tone={onlineHost ? "active" : "waiting"}
            pulse={!onlineHost}
            label={onlineHost ? `${onlineHost.name} is online` : "Waiting for your machine"}
          />
          <span>{onlineHost ? `${onlineHost.name} is online.` : "Waiting for your machine…"}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function PairingCodeForm({
  onApproved,
  autoLoadFromUrl = false,
}: {
  onApproved?: (hostName: string) => void;
  /**
   * Read `?ref=`/`?code=` and the `#k=` identity fragment from the URL and
   * load the pending approval on mount. Only the possession route (`/device`,
   * which the daemon's own link opens) arrives with those; the Settings and
   * onboarding embeddings type a code by hand and leave this off.
   */
  autoLoadFromUrl?: boolean;
} = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const [code, setCode] = useState("");
  const [hostName, setHostName] = useState<string | null>(null);
  const [pending, setPending] = useState<DevicePendingApproval | null>(null);
  const [localPinState, setLocalPinState] = useState<BrowserHostPinState | "new" | null>(null);
  const [localPinCommitted, setLocalPinCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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

  const resetCeremony = () => {
    setPending(null);
    setFragmentVerified(false);
    setRefusal(null);
    fragmentKeyRef.current = null;
    setLocalPinState(null);
    setLocalPinCommitted(false);
    setStopped(false);
    setError(null);
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
    setSubmitting(true);
    try {
      const response = await auth.pendingDevice(lookup);
      const expectedFingerprint = await ed25519PublicKeyFingerprint(response.host_public_key);
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
      setFragmentVerified(fragmentKey !== null);
      setIdentifier(lookup);
      setPending(response);
      setLocalPinState(existing?.state ?? "new");
      setLocalPinCommitted(existing?.state === "active");
    } catch (caught) {
      setError(
        caught instanceof ApiError || caught instanceof ApprovalIdentityError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Approval failed",
      );
    } finally {
      setSubmitting(false);
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
    if (!(ref || urlCode) || !user || autoTriedRef.current) return;
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
    setSubmitting(true);
    let localPinPersisted = false;
    try {
      const localIdentity = await loadBrowserDeviceIdentity(user.id);
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
      localPinPersisted = true;
      setLocalPinCommitted(true);
      setLocalPinState("active");
      const signature = await createHostPairApprovalProof(
        localIdentity,
        user.id,
        pending.approval_nonce,
        pending.host_public_key,
      );
      const response = await auth.approveDevice({
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
        browser_key_fingerprint: await ed25519PublicKeyFingerprint(
          registration.data.device.public_key,
        ),
        signature,
      });
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
      setSubmitting(false);
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
        <Button type="button" variant="secondary" onClick={resetCeremony}>
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

  return (
    <form className="space-y-3" onSubmit={onReview}>
      <div className="space-y-1.5">
        <Label htmlFor="host-pairing-code">Code from the terminal</Label>
        <Input
          id="host-pairing-code"
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

      {error && !retryable && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
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
            phase={checkPhase}
            mode="enter"
            fingerprint={pending?.host_key_fingerprint}
            otherScreen="in the host's terminal"
            doneText={`${hostName} is possessed. All your devices can reach it.`}
            stoppedText="The fingerprints don't match, so nothing was trusted. Start over from the host's terminal."
            onMatch={() => void onApprove()}
            onNoMatch={() => {
              // A fingerprint mismatch is terminal — never a retry loop.
              setStopped(true);
            }}
            onDone={resetCeremony}
            onClose={resetCeremony}
          />
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
